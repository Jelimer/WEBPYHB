// BYMA Live Analytics - Lógica del Frontend (app.js)

// 1. Configuración de Supabase
const SUPABASE_URL = "https://tgteeavasdjaclzqzcsb.supabase.co"; 
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRndGVlYXZhc2RqYWNsenF6Y3NiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMzE1NzIsImV4cCI6MjA5NDgwNzU3Mn0.OqEIqduZnX5JB2nbbaDMFKdm2vRr7kqYRXWJ6RYJe64"; 


let supabaseClient = null;
let currentTicker = null;
let chart = null;
let candleSeries = null;
let volumeSeries = null;
let tickerMap = {}; // { id: { ticker, type, underlying_id } }

// 2. Inicialización
document.addEventListener("DOMContentLoaded", () => {
    initSupabase();
    initChart();
    loadActiveTickers();
    setupEventListeners();
});

// Inicializar cliente Supabase
function initSupabase() {
    if (SUPABASE_URL.includes("tu-proyecto") || SUPABASE_KEY === "tu-anon-key") {
        console.warn("ADVERTENCIA: Por favor configura SUPABASE_URL y SUPABASE_KEY con valores reales.");
        return;
    }
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log("Cliente Supabase inicializado correctamente.");
    
    // Suscripción a cambios en tiempo real
    setupRealtimeSubscription();
}

// Inicializar el Gráfico (TradingView Lightweight Charts)
function initChart() {
    const container = document.getElementById("chart-viewport");
    
    // Ocultar placeholder
    container.innerHTML = "";
    
    chart = LightweightCharts.createChart(container, {
        layout: {
            background: { color: '#0a0f18' },
            textColor: '#94a3b8',
        },
        grid: {
            vertLines: { color: '#1e293b' },
            horzLines: { color: '#1e293b' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
        },
        timeScale: {
            timeVisible: true,
            secondsVisible: false,
            borderColor: '#334155',
        },
    });

    // Serie de velas (Candlestick)
    candleSeries = chart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#ef4444',
        borderUpColor: '#10b981',
        borderDownColor: '#ef4444',
        wickUpColor: '#10b981',
        wickDownColor: '#ef4444',
    });

    // Serie de Volumen (Panel inferior integrado)
    volumeSeries = chart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: {
            type: 'volume',
        },
        priceScaleId: '', // Escala propia secundaria para no solapar precios
    });
    
    volumeSeries.priceScale().applyOptions({
        scaleMargins: {
            top: 0.8, // Ocupa el 20% inferior del gráfico
            bottom: 0,
        },
    });

    // Hacer el gráfico responsivo
    const resizeObserver = new ResizeObserver(entries => {
        if (entries.length === 0 || !entries[0]) return;
        const { width, height } = entries[0].contentRect;
        chart.resize(width, height);
    });
    resizeObserver.observe(container);
}

// Cargar la Lista Blanca de Tickers Activos
async function loadActiveTickers() {
    if (!supabaseClient) return;

    try {
        // Obtenemos la whitelist y los detalles de los instrumentos asociados
        const { data, error } = await supabaseClient
            .from('whitelist')
            .select('instrument_id, is_active, instruments(id, ticker, type, underlying_id)')
            .eq('is_active', true);

        if (error) throw error;

        const listContainer = document.getElementById("ticker-list");
        listContainer.innerHTML = "";
        tickerMap = {};
        
        let count = 0;

        data.forEach(item => {
            const inst = item.instruments;
            if (!inst) return;
            
            count++;
            tickerMap[inst.id] = {
                ticker: inst.ticker,
                type: inst.type,
                underlying_id: inst.underlying_id
            };

            // Creamos el elemento visual en la lista
            const itemEl = document.createElement("div");
            itemEl.classList.add("ticker-item");
            itemEl.setAttribute("data-id", inst.id);
            itemEl.setAttribute("data-ticker", inst.ticker);
            
            const icon = inst.type === 'OPTION' ? 'fa-signature' : 'fa-cubes';
            const typeLabel = inst.type === 'OPTION' ? 'OPCIÓN' : 'ACCIÓN';

            itemEl.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <i class="fa-solid ${icon}" style="color: var(--color-accent); font-size: 13px;"></i>
                    <div>
                        <div class="ticker-name">${inst.ticker}</div>
                        <div style="font-size: 9px; color: var(--color-text-muted); font-weight:600;">${typeLabel}</div>
                    </div>
                </div>
                <div class="ticker-price" id="ticker-price-${inst.id}">-</div>
            `;

            itemEl.addEventListener("click", () => selectTicker(inst.id));
            listContainer.appendChild(itemEl);
        });

        document.getElementById("whitelist-count").textContent = count;

    } catch (err) {
        console.error("Error cargando tickers de Supabase:", err);
        document.getElementById("ticker-list").innerHTML = `
            <div class="list-placeholder" style="color: var(--color-ask)">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <p>Error de conexión</p>
            </div>
        `;
    }
}

// Seleccionar un Ticker del Panel Lateral y Cargar su Historial
async function selectTicker(id) {
    const asset = tickerMap[id];
    if (!asset) return;

    currentTicker = { id, ...asset };

    // Estilo activo en lista
    document.querySelectorAll(".ticker-item").forEach(el => {
        el.classList.remove("active");
        if (el.getAttribute("data-id") == id) {
            el.classList.add("active");
        }
    });

    // Mostrar el encabezado de detalles
    const detailHeader = document.getElementById("selected-ticker-header");
    detailHeader.style.display = "flex";
    document.getElementById("selected-ticker-name").textContent = asset.ticker;
    document.getElementById("selected-ticker-type").textContent = asset.type === 'OPTION' ? 'Opcion Financiera' : 'Acción Líder (Subyacente)';

    // Consultar el historial de market_data_1m (Últimas 200 velas)
    try {
        const { data, error } = await supabaseClient
            .from('market_data_1m')
            .select('*')
            .eq('instrument_id', id)
            .order('timestamp', { ascending: true })
            .limit(200);

        if (error) throw error;

        // Formatear datos para TradingView Charts
        const candles = [];
        const volumes = [];

        data.forEach(row => {
            const timeUnix = Math.floor(new Date(row.timestamp).getTime() / 1000);
            
            candles.push({
                time: timeUnix,
                open: parseFloat(row.open_price),
                high: parseFloat(row.high_price),
                low: parseFloat(row.low_price),
                close: parseFloat(row.close_price)
            });

            volumes.push({
                time: timeUnix,
                value: parseInt(row.volume),
                color: parseFloat(row.close_price) >= parseFloat(row.open_price) ? '#10b98144' : '#ef444444'
            });
        });

        // Setear datos en las series del gráfico
        candleSeries.setData(candles);
        volumeSeries.setData(volumes);
        
        // Ajustar vista del gráfico
        chart.timeScale().fitContent();

        // Actualizar métricas del panel derecho e inferior
        if (data.length > 0) {
            const lastRow = data[data.length - 1];
            updateDetailPanels(lastRow);
        } else {
            resetDetailPanels();
        }

    } catch (err) {
        console.error("Error al obtener histórico del activo:", err);
    }
}

// Escuchar cambios de Supabase en tiempo real (PostgreSQL Channels)
function setupRealtimeSubscription() {
    if (!supabaseClient) return;

    supabaseClient
        .channel('schema-db-changes')
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'market_data_1m'
            },
            (payload) => {
                const newRow = payload.new;
                
                // 1. Actualizar el precio rápido en el panel lateral de tickers
                const priceLabel = document.getElementById(`ticker-price-${newRow.instrument_id}`);
                if (priceLabel) {
                    priceLabel.textContent = `$${parseFloat(newRow.close_price).toFixed(2)}`;
                    priceLabel.style.color = parseFloat(newRow.close_price) >= parseFloat(newRow.open_price) ? 'var(--color-bid)' : 'var(--color-ask)';
                }

                // 2. Si es el ticker seleccionado actualmente, actualizamos el gráfico y los paneles
                if (currentTicker && newRow.instrument_id == currentTicker.id) {
                    const timeUnix = Math.floor(new Date(newRow.timestamp).getTime() / 1000);
                    
                    // Actualizar/Agregar vela al gráfico en tiempo real
                    candleSeries.update({
                        time: timeUnix,
                        open: parseFloat(newRow.open_price),
                        high: parseFloat(newRow.high_price),
                        low: parseFloat(newRow.low_price),
                        close: parseFloat(newRow.close_price)
                    });

                    volumeSeries.update({
                        time: timeUnix,
                        value: parseInt(newRow.volume),
                        color: parseFloat(newRow.close_price) >= parseFloat(newRow.open_price) ? '#10b98144' : '#ef444444'
                    });

                    // Actualizar paneles visuales
                    updateDetailPanels(newRow);
                }
            }
        )
        .subscribe();
}

// Helper para actualizar paneles de precios e información
function updateDetailPanels(row) {
    const formattedPrice = `$${parseFloat(row.close_price).toFixed(2)}`;
    
    // Header
    document.getElementById("header-last-price").textContent = formattedPrice;
    document.getElementById("header-volume").textContent = parseInt(row.volume).toLocaleString('es-AR');
    
    const dateStr = new Date(row.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    document.getElementById("header-time").textContent = `${dateStr} hs`;

    // Orderbook / Bid & Ask
    const bidVal = row.bid_price ? `$${parseFloat(row.bid_price).toFixed(2)}` : "-";
    const askVal = row.ask_price ? `$${parseFloat(row.ask_price).toFixed(2)}` : "-";
    
    document.getElementById("bid-price").textContent = bidVal;
    document.getElementById("ask-price").textContent = askVal;

    // Calcular Spread %
    if (row.bid_price && row.ask_price) {
        const spread = parseFloat(row.ask_price) - parseFloat(row.bid_price);
        const spreadPct = (spread / parseFloat(row.bid_price)) * 100;
        document.getElementById("spread-pct").textContent = `${spreadPct.toFixed(2)}%`;
    } else {
        document.getElementById("spread-pct").textContent = "-%";
    }

    // Cuadrícula OHLC inferior
    document.getElementById("ohlc-open").textContent = `$${parseFloat(row.open_price).toFixed(2)}`;
    document.getElementById("ohlc-high").textContent = `$${parseFloat(row.high_price).toFixed(2)}`;
    document.getElementById("ohlc-low").textContent = `$${parseFloat(row.low_price).toFixed(2)}`;
    document.getElementById("ohlc-close").textContent = `$${parseFloat(row.close_price).toFixed(2)}`;
    
    // Cambiar color de fuente según tendencia del minuto
    const trendColor = parseFloat(row.close_price) >= parseFloat(row.open_price) ? 'var(--color-bid)' : 'var(--color-ask)';
    document.getElementById("header-last-price").style.color = trendColor;
}

function resetDetailPanels() {
    document.getElementById("header-last-price").textContent = "-";
    document.getElementById("header-volume").textContent = "-";
    document.getElementById("header-time").textContent = "-";
    document.getElementById("bid-price").textContent = "-";
    document.getElementById("ask-price").textContent = "-";
    document.getElementById("spread-pct").textContent = "-%";
    document.getElementById("ohlc-open").textContent = "-";
    document.getElementById("ohlc-high").textContent = "-";
    document.getElementById("ohlc-low").textContent = "-";
    document.getElementById("ohlc-close").textContent = "-";
}

// Configurar buscador del panel lateral
function setupEventListeners() {
    const searchInput = document.getElementById("ticker-search");
    searchInput.addEventListener("input", (e) => {
        const query = e.target.value.toUpperCase();
        document.querySelectorAll(".ticker-item").forEach(item => {
            const ticker = item.getAttribute("data-ticker");
            if (ticker.includes(query)) {
                item.style.display = "flex";
            } else {
                item.style.display = "none";
            }
        });
    });
}
