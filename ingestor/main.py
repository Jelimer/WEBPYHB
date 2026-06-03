import os
import time
import threading
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
import pandas as pd
import pyRofex
from dotenv import load_dotenv
from supabase import create_client, Client
from apscheduler.schedulers.background import BackgroundScheduler

# Diccionario lógico de mapeo BYMA (Opciones -> Acciones Subyacentes)
BYMA_UNDERLYING_MAP = {
    "GFG": "GGAL",  # Grupo Financiero Galicia
    "PAM": "PAMP",  # Pampa Energía
    "YPF": "YPFD",  # YPF
    "ALU": "ALUA",  # Aluar
    "TXA": "TXAR",  # Ternium Argentina
    "BMA": "BMA",   # Banco Macro
    "CEC": "CECO2", # Central Puerto
    "COM": "COME",  # Sociedad Comercial del Plata
    "MET": "METR"   # MetroGAS S.A.
}

class MarketDataIngestor:
    def __init__(self, broker_user, broker_pass, broker_account, supabase_url, supabase_key):
        # 1. Inicializar clientes y estructuras
        self.supabase: Client = create_client(supabase_url, supabase_key)
        self.broker_user = broker_user
        self.broker_pass = broker_pass
        self.broker_account = broker_account
        
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
                
                # Registramos en el mapeo general de IDs
                self.ticker_to_id[ticker] = instrument_id
                
                if inst_type == 'OPTION':
                    opciones_activas.append(ticker)
                else:
                    subyacentes_necesarios.add(ticker)
                
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

    def on_market_data(self, message):
        # Callback para procesamiento de ticks del WebSocket en tiempo real de pyRofex
        try:
            symbol = message.get('instrumentId', {}).get('symbol')
            if not symbol:
                return

            # Limpiamos el prefijo de Matba Rofex "MERV - XMEV - " y sufijos de plazo " - 24hs" o " - CI"
            clean_symbol = symbol.replace("MERV - XMEV - ", "")
            if clean_symbol.endswith(" - 24hs"):
                clean_symbol = clean_symbol[:-7]
            elif clean_symbol.endswith(" - CI"):
                clean_symbol = clean_symbol[:-5]

            # Verificar si está en la whitelist activa
            if clean_symbol not in self.whitelist_set:
                return

            market_data = message.get('marketData', {})
            if not market_data:
                return

            # 1. Extracción del precio y volumen del último trade
            last_trade = market_data.get('LA', {})
            last = last_trade.get('price') if isinstance(last_trade, dict) else None
            last_size = last_trade.get('size') if isinstance(last_trade, dict) else None
            
            # Si no hay trade price, no podemos conformar la vela
            if last is None or pd.isna(last):
                return

            # 2. Extracción del volumen nominal acumulado del día (NV)
            volume = market_data.get('NV', 0)

            # 3. Extracción de bid/ask (precios y cantidades en la mejor oferta)
            bids = market_data.get('BI', [])
            bid = bids[0].get('price') if bids and isinstance(bids, list) else None
            bid_size = bids[0].get('size') if bids and isinstance(bids, list) else None

            offers = market_data.get('OF', [])
            ask = offers[0].get('price') if offers and isinstance(offers, list) else None
            ask_size = offers[0].get('size') if offers and isinstance(offers, list) else None

            # 4. Extracción de estadísticas adicionales de la rueda (operaciones, turnover, interés abierto)
            operations = market_data.get('TC', 0)     # Trade Count acumulado del día
            turnover = market_data.get('EV', 0.0)    # Effective Volume acumulado del día
            
            oi_data = market_data.get('OI')          # Open Interest
            open_interest = oi_data.get('price') if isinstance(oi_data, dict) else oi_data

            now_utc = datetime.now(timezone.utc)
            minute_key = now_utc.replace(second=0, microsecond=0)

            # Escritura Thread-Safe en el buffer de agregación
            with self.lock:
                buffer_key = (clean_symbol, minute_key)
                if buffer_key not in self.buffer_1m:
                    self.buffer_1m[buffer_key] = {
                        'open_price': last,
                        'high_price': last,
                        'low_price': last,
                        'close_price': last,
                        'accumulated_volume': volume,
                        'bid_price': bid,
                        'ask_price': ask,
                        'bid_size': bid_size,
                        'ask_size': ask_size,
                        'last_size': last_size,
                        'operations': operations,
                        'turnover': turnover,
                        'open_interest': open_interest
                    }
                else:
                    record = self.buffer_1m[buffer_key]
                    record['high_price'] = max(record['high_price'], last)
                    record['low_price'] = min(record['low_price'], last)
                    record['close_price'] = last
                    record['accumulated_volume'] = volume
                    record['bid_price'] = bid
                    record['ask_price'] = ask
                    record['bid_size'] = bid_size
                    record['ask_size'] = ask_size
                    record['last_size'] = last_size
                    record['operations'] = operations
                    record['turnover'] = turnover
                    record['open_interest'] = open_interest

        except Exception as e:
            print(f"Error al procesar tick para el símbolo {symbol if 'symbol' in locals() else 'desconocido'}: {str(e)}")

    def on_websocket_error(self, message):
        print(f"ALERTA: Error en conexión WebSocket de pyRofex: {message}")

    def on_websocket_exception(self, exception):
        print(f"EXCEPCIÓN: Error interno en el WebSocket de pyRofex: {exception}")

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
                "ask_price": float(metricas["ask_price"]) if metricas["ask_price"] is not None else None,
                "bid_size": int(metricas["bid_size"]) if metricas["bid_size"] is not None else None,
                "ask_size": int(metricas["ask_size"]) if metricas["ask_size"] is not None else None,
                "last_size": int(metricas["last_size"]) if metricas["last_size"] is not None else None,
                "operations": int(metricas["operations"]) if metricas["operations"] is not None else None,
                "turnover": float(metricas["turnover"]) if metricas["turnover"] is not None else None,
                "open_interest": int(metricas["open_interest"]) if metricas["open_interest"] is not None else None
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

        # Conexión e inicio de sesión con pyRofex en Veta Capital
        print("Inicializando pyRofex con API Veta Capital...")
        try:
            # Configurar endpoints de Veta Capital en el entorno LIVE
            pyRofex._set_environment_parameter('url', "https://api.veta.xoms.com.ar/", pyRofex.Environment.LIVE)
            pyRofex._set_environment_parameter('ws', "wss://api.veta.xoms.com.ar/", pyRofex.Environment.LIVE)
            
            pyRofex.initialize(
                environment=pyRofex.Environment.LIVE,
                user=self.broker_user,
                password=self.broker_pass,
                account=self.broker_account
            )
            print("Autenticación con la API de Veta Capital exitosa.")
        except Exception as e:
            print(f"ERROR CRÍTICO: Fallo al inicializar pyRofex: {str(e)}")
            scheduler.shutdown()
            raise e

        # Inicialización de la conexión WebSocket
        print("Conectando al WebSocket de datos de mercado en tiempo real...")
        try:
            pyRofex.init_websocket_connection(
                market_data_handler=self.on_market_data,
                error_handler=self.on_websocket_error,
                exception_handler=self.on_websocket_exception
            )
            print("Conexión WebSocket establecida.")
        except Exception as e:
            print(f"ERROR CRÍTICO: No se pudo establecer la conexión WebSocket: {str(e)}")
            scheduler.shutdown()
            raise e
        
        # Suscribir a los instrumentos de la Whitelist formateados a Rofex
        rofex_symbols = []
        for ticker in self.whitelist:
            if ticker in self.options_whitelist:
                # Opciones en BYMA se operan en Contado Inmediato (CI) en Matba Rofex
                rofex_symbol = f"MERV - XMEV - {ticker} - CI"
            else:
                # Acciones líderes sí se negocian en plazo 24hs por defecto
                rofex_symbol = f"MERV - XMEV - {ticker} - 24hs"
            rofex_symbols.append(rofex_symbol)
            
        if rofex_symbols:
            print(f"Suscribiendo a {len(rofex_symbols)} símbolos en Matba Rofex: {rofex_symbols}...")
            entries = [
                pyRofex.MarketDataEntry.BIDS,
                pyRofex.MarketDataEntry.OFFERS,
                pyRofex.MarketDataEntry.LAST,
                pyRofex.MarketDataEntry.OPENING_PRICE,
                pyRofex.MarketDataEntry.CLOSING_PRICE,
                pyRofex.MarketDataEntry.HIGH_PRICE,
                pyRofex.MarketDataEntry.LOW_PRICE,
                pyRofex.MarketDataEntry.NOMINAL_VOLUME,
                pyRofex.MarketDataEntry.TRADE_COUNT,
                pyRofex.MarketDataEntry.TRADE_EFFECTIVE_VOLUME,
                pyRofex.MarketDataEntry.OPEN_INTEREST
            ]
            try:
                pyRofex.market_data_subscription(tickers=rofex_symbols, entries=entries)
                print("Suscripción de datos de mercado completada con éxito.")
            except Exception as sub_err:
                print(f"ERROR al enviar la suscripción de tickers: {str(sub_err)}")
        
        # Mantener el daemon vivo 24/5
        print("Servicio de ingesta en tiempo real (pyRofex) en ejecución. Presione Ctrl+C para detener.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("Deteniendo servicio de ingesta dual...")
            try:
                pyRofex.close_websocket_connection()
            except Exception:
                pass
            scheduler.shutdown()
            print("Servicio de ingesta detenido con éxito.")

class SimpleHTTPRequestHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-type', 'text/plain')
        self.end_headers()
        self.wfile.write(b"OK")
    def log_message(self, format, *args):
        # Evitar inundar la consola de logs de peticiones HTTP
        return

def run_http_server():
    port = int(os.getenv("PORT", 10000))
    server = HTTPServer(('0.0.0.0', port), SimpleHTTPRequestHandler)
    print(f"Servidor HTTP auxiliar de mantenimiento activo en puerto {port}...")
    server.serve_forever()

if __name__ == '__main__':
    load_dotenv()

    # Mapeo de credenciales locales a variables de pyRofex
    BROKER_USER = (os.getenv("BROKER_USER") or "").strip()
    BROKER_PASS = (os.getenv("BROKER_PASS") or "").strip()
    BROKER_ACCOUNT = (os.getenv("BROKER_ACCOUNT") or "").strip()
    SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip()
    SUPABASE_KEY = (os.getenv("SUPABASE_KEY") or "").strip()

    if not all([BROKER_USER, BROKER_PASS, BROKER_ACCOUNT, SUPABASE_URL, SUPABASE_KEY]):
        print("Error: Faltan variables de entorno requeridas en el archivo .env")
        print("Asegúrate de configurar: BROKER_USER, BROKER_PASS, BROKER_ACCOUNT, SUPABASE_URL, SUPABASE_KEY")
        exit(1)

    # Iniciar servidor HTTP auxiliar para evitar suspensión en hostings gratuitos
    http_thread = threading.Thread(target=run_http_server, daemon=True)
    http_thread.start()

    ingestor = MarketDataIngestor(
        broker_user=BROKER_USER,
        broker_pass=BROKER_PASS,
        broker_account=BROKER_ACCOUNT,
        supabase_url=SUPABASE_URL,
        supabase_key=SUPABASE_KEY
    )
    ingestor.run()
