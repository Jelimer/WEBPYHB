import os
import time
import threading
from datetime import datetime, timezone
import pandas as pd
import pyhomebroker
from dotenv import load_dotenv
from supabase import create_client, Client
from apscheduler.schedulers.background import BackgroundScheduler

# Corrección de URL de Veta Capital (HTTP -> HTTPS) para evitar fallas de redirección en pyhomebroker
for b in pyhomebroker.common.brokers:
    if b.get('broker_id') == 284:
        b['page'] = 'https://cuentas.vetacapital.com.ar'

# Diccionario lógico de mapeo BYMA (Opciones -> Acciones Subyacentes)
BYMA_UNDERLYING_MAP = {
    "GFG": "GGAL",  # Grupo Financiero Galicia
    "PAM": "PAMP",  # Pampa Energía
    "YPF": "YPFD",  # YPF
    "ALU": "ALUA",  # Aluar
    "TXA": "TXAR",  # Ternium Argentina
    "BMA": "BMA",   # Banco Macro
    "CEC": "CECO2", # Central Puerto
    "COM": "COME"   # Sociedad Comercial del Plata
}

class MarketDataIngestor:
    def __init__(self, broker_id, broker_dni, broker_user, broker_pass, supabase_url, supabase_key):
        # 1. Inicializar clientes y estructuras
        self.supabase: Client = create_client(supabase_url, supabase_key)
        self.broker_id = int(broker_id)
        self.broker_dni = broker_dni
        self.broker_user = broker_user
        self.broker_pass = broker_pass
        
        self.broker = pyhomebroker.HomeBroker(self.broker_id)
        
        self.options_whitelist = []
        self.equity_whitelist = []
        self.whitelist = []
        self.whitelist_set = set()
        self.ticker_to_id = {}
        
        self.buffer_1m = {}  # Diccionario para agrupar ticks (clave: (ticker, timestamp_minuto))
        self.lock = threading.Lock()  # Lock para proteger accesos concurrentes al buffer
        
    def load_whitelist(self):
        # 2. Consultar Supabase, resolver subyacentes e implementar auto-mapeo
        try:
            print("Cargando lista blanca de instrumentos activos desde Supabase...")
            
            # Consultamos la tabla whitelist trayendo los campos relacionales de instruments
            response = self.supabase.table('whitelist') \
                .select('instrument_id, is_active, instruments(id, ticker, type, underlying_id)') \
                .eq('is_active', True) \
                .execute()
            
            opciones_activas = []
            subyacentes_necesarios = set()
            self.ticker_to_id = {}
            
            for item in response.data:
                inst_data = item.get('instruments')
                if not inst_data or not isinstance(inst_data, dict):
                    continue
                
                ticker = inst_data.get('ticker')
                instrument_id = inst_data.get('id')
                underlying_id = inst_data.get('underlying_id')
                inst_type = inst_data.get('type')
                
                if not ticker or not instrument_id:
                    continue
                
                # Registramos el ID de la opción
                self.ticker_to_id[ticker] = instrument_id
                opciones_activas.append(ticker)
                
                # Intentar resolver el subyacente
                if underlying_id is None:
                    # Aplicamos auto-mapeo dinámico si no está definido en base de datos
                    prefijo_3 = ticker[:3].upper()
                    prefijo_4 = ticker[:4].upper()
                    underlying_ticker = BYMA_UNDERLYING_MAP.get(prefijo_3) or BYMA_UNDERLYING_MAP.get(prefijo_4)
                    
                    if underlying_ticker:
                        print(f"Detectado subyacente automático para {ticker} -> {underlying_ticker}")
                        # Buscar el subyacente en la base de datos para obtener su ID
                        sub_resp = self.supabase.table('instruments') \
                            .select('id') \
                            .eq('ticker', underlying_ticker) \
                            .execute()
                        
                        if sub_resp.data:
                            sub_id = sub_resp.data[0]['id']
                            # Guardamos en la base de datos la relación para el futuro (Autocuración de esquema)
                            try:
                                self.supabase.table('instruments') \
                                    .update({'underlying_id': sub_id}) \
                                    .eq('id', instrument_id) \
                                    .execute()
                                print(f"Asociado exitosamente {ticker} con subyacente ID {sub_id} en Supabase.")
                            except Exception as update_err:
                                print(f"Advertencia: No se pudo persistir la relación de subyacente en BD: {str(update_err)}")
                            
                            underlying_id = sub_id
                            subyacentes_necesarios.add(underlying_ticker)
                            self.ticker_to_id[underlying_ticker] = sub_id
                        else:
                            print(f"Advertencia: El subyacente {underlying_ticker} no está registrado en la tabla instruments.")
                else:
                    # Si ya está definido en la base de datos, obtenemos el ticker del subyacente
                    try:
                        sub_resp = self.supabase.table('instruments') \
                            .select('ticker') \
                            .eq('id', underlying_id) \
                            .execute()
                        
                        if sub_resp.data:
                            underlying_ticker = sub_resp.data[0]['ticker']
                            subyacentes_necesarios.add(underlying_ticker)
                            self.ticker_to_id[underlying_ticker] = underlying_id
                    except Exception as e:
                        print(f"Error al obtener ticker del subyacente ID {underlying_id}: {str(e)}")

            self.options_whitelist = opciones_activas
            self.equity_whitelist = list(subyacentes_necesarios)
            self.whitelist = self.options_whitelist + self.equity_whitelist
            self.whitelist_set = set(self.whitelist)
            
            print(f"Carga finalizada:")
            print(f" - Opciones activas: {len(self.options_whitelist)} {self.options_whitelist}")
            print(f" - Subyacentes a suscribir: {len(self.equity_whitelist)} {self.equity_whitelist}")
            print(f" - Mapeo de IDs en memoria: {self.ticker_to_id}")
            
        except Exception as e:
            print(f"Error al cargar la lista blanca desde Supabase: {str(e)}")
            raise e

    def on_options_update(self, online, quotes):
        # Callback para opciones financieras
        self._process_tick_data(quotes)

    def on_equity_update(self, online, quotes):
        # Callback para acciones (subyacentes)
        self._process_tick_data(quotes)

    def _process_tick_data(self, quotes):
        # 3. Procesamiento y unificación de ticks en el buffer temporal
        if quotes is None:
            return

        now_utc = datetime.now(timezone.utc)
        minute_key = now_utc.replace(second=0, microsecond=0)

        # Cachear referencias locales para optimizar velocidad (Hot Path)
        local_buffer = self.buffer_1m
        whitelist = self.whitelist_set
        local_max = max
        local_min = min

        items_to_process = []
        
        # Normalización del iterable de entrada
        if isinstance(quotes, pd.DataFrame):
            for idx, row in quotes.iterrows():
                ticker = row.get('symbol') or row.get('ticker') or idx
                items_to_process.append((ticker, row))
        elif isinstance(quotes, dict):
            items_to_process = quotes.items()
        else:
            try:
                items_to_process = [(item.get('symbol') or item.get('ticker'), item) for item in quotes]
            except Exception:
                return

        # Procesar los ticks uno por uno
        for ticker, data in items_to_process:
            if not ticker or ticker not in whitelist:
                continue

            try:
                last = data.get('last') if hasattr(data, 'get') else getattr(data, 'last', None)
                volume = data.get('volume') if hasattr(data, 'get') else getattr(data, 'volume', 0)
                bid = data.get('bid') if hasattr(data, 'get') else getattr(data, 'bid', None)
                ask = data.get('ask') if hasattr(data, 'get') else getattr(data, 'ask', None)
                
                if last is None or pd.isna(last):
                    continue

                buffer_key = (ticker, minute_key)

                # Escritura protegida por Lock (Thread-Safe)
                with self.lock:
                    if buffer_key not in local_buffer:
                        local_buffer[buffer_key] = {
                            'open_price': last,
                            'high_price': last,
                            'low_price': last,
                            'close_price': last,
                            'accumulated_volume': volume,
                            'bid_price': bid,
                            'ask_price': ask
                        }
                    else:
                        record = local_buffer[buffer_key]
                        record['high_price'] = local_max(record['high_price'], last)
                        record['low_price'] = local_min(record['low_price'], last)
                        record['close_price'] = last
                        record['accumulated_volume'] = volume
                        record['bid_price'] = bid
                        record['ask_price'] = ask

            except Exception as e:
                print(f"Error al procesar tick para {ticker}: {str(e)}")

    def flush_to_database(self):
        # 4. Cron: Swap de buffers e inserción por lotes en Supabase
        with self.lock:
            if not self.buffer_1m:
                return
            datos_a_guardar = self.buffer_1m
            self.buffer_1m = {}

        print(f"Persistiendo en Supabase {len(datos_a_guardar)} registros consolidados por minuto...")

        registros_a_insertar = []

        for (ticker, timestamp), metricas in datos_a_guardar.items():
            instrument_id = self.ticker_to_id.get(ticker)
            if not instrument_id:
                continue

            registro = {
                "instrument_id": instrument_id,
                "timestamp": timestamp.isoformat(),
                "open_price": float(metricas["open_price"]),
                "high_price": float(metricas["high_price"]),
                "low_price": float(metricas["low_price"]),
                "close_price": float(metricas["close_price"]),
                "volume": int(metricas["accumulated_volume"]),
                "bid_price": float(metricas["bid_price"]) if metricas["bid_price"] is not None else None,
                "ask_price": float(metricas["ask_price"]) if metricas["ask_price"] is not None else None
            }
            registros_a_insertar.append(registro)

        if registros_a_insertar:
            try:
                self.supabase.table('market_data_1m').insert(registros_a_insertar).execute()
                print(f"Bulk insert exitoso. Se grabaron {len(registros_a_insertar)} registros en market_data_1m.")
            except Exception as e:
                print(f"ERROR en flush_to_database al insertar en Supabase: {str(e)}")

    def run(self):
        self.load_whitelist()
        
        # Iniciar el scheduler cron cada 60 segundos
        scheduler = BackgroundScheduler()
        scheduler.add_job(self.flush_to_database, 'interval', seconds=60)
        scheduler.start()
        print("Planificador APScheduler iniciado correctamente.")

        # Conexión y suscripciones duales al broker
        print(f"Autenticando en pyhomebroker (Broker ID: {self.broker_id})...")
        self.broker.auth.login(
            dni=self.broker_dni,
            user=self.broker_user,
            password=self.broker_pass,
            raise_exception=True
        )
        print("Conectando con el WebSocket del broker...")
        self.broker.online.connect()
        
        # 1. Suscripción a Opciones Financieras
        if self.options_whitelist:
            print(f"Suscribiendo a {len(self.options_whitelist)} opciones en tiempo real...")
            self.broker.online.subscribe_options(self.options_whitelist, self.on_options_update)
            
        # 2. Suscripción a Acciones Subyacentes
        if self.equity_whitelist:
            print(f"Suscribiendo a {len(self.equity_whitelist)} subyacentes líderes en tiempo real...")
            self.broker.online.subscribe_equity(self.equity_whitelist, self.on_equity_update)
        
        # Mantener el daemon vivo 24/5
        print("Servicio de ingesta dual en ejecución. Presione Ctrl+C para detener.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("Deteniendo servicio de ingesta...")
            self.broker.online.disconnect()
            scheduler.shutdown()
            print("Servicio detenido exitosamente.")

if __name__ == '__main__':
    load_dotenv()

    BROKER_ID = (os.getenv("BROKER_ID") or "").strip()
    BROKER_DNI = (os.getenv("BROKER_DNI") or os.getenv("BROKER_USER") or "").strip()
    BROKER_USER = (os.getenv("BROKER_USER") or "").strip()
    BROKER_PASS = (os.getenv("BROKER_PASS") or "").strip()
    SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip()
    SUPABASE_KEY = (os.getenv("SUPABASE_KEY") or "").strip()

    if not all([BROKER_ID, BROKER_USER, BROKER_PASS, SUPABASE_URL, SUPABASE_KEY]):
        print("Error: Faltan variables de entorno requeridas en el archivo .env")
        print("Asegúrate de configurar: BROKER_ID, BROKER_USER, BROKER_PASS, SUPABASE_URL, SUPABASE_KEY")
        exit(1)

    ingestor = MarketDataIngestor(
        broker_id=BROKER_ID,
        broker_dni=BROKER_DNI,
        broker_user=BROKER_USER,
        broker_pass=BROKER_PASS,
        supabase_url=SUPABASE_URL,
        supabase_key=SUPABASE_KEY
    )
    ingestor.run()
