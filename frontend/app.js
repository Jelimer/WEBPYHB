// BYMA Live Analytics - Lógica del Frontend (app.js)

// 1. Configuración de Supabase
const SUPABASE_URL = "https://tgteeavasdjaclzqzcsb.supabase.co"; 
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRndGVlYXZhc2RqYWNsenF6Y3NiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMzE1NzIsImV4cCI6MjA5NDgwNzU3Mn0.OqEIqduZnX5JB2nbbaDMFKdm2vRr7kqYRXWJ6RYJe64"; 

let supabaseClient = null;
let currentTicker = null;
let tickerMap = {}; // { id: { ticker, type, underlying_id } }
let marketDataMap = {}; // { id: { id, ticker, type, close_price, volume, open_price, variation } }

// Estados globales para ordenación, búsquedas y filtros por volumen
let sortState = {
    subyacentes: { column: 'volume', order: 'desc' },
    opciones: { column: 'volume', order: 'desc' }
};
let subyacentesSearchQuery = "";
let opcionesSearchQuery = "";
let subyacentesVolFilter = 0;
let opcionesVolFilter = 0;

// Formateadores numéricos con estilo local de Argentina (separador de miles '.' y decimal ',')
function formatPrice(val) {
    if (val === null || val === undefined || isNaN(val) || val === "") return "-";
    return `$${parseFloat(val).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPriceRaw(val) {
    if (val === null || val === undefined || isNaN(val) || val === "") return "-";
    return parseFloat(val).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(val) {
    if (val === null || val === undefined || isNaN(val) || val === "") return "-";
    const parsed = parseFloat(val);
    const sign = parsed > 0 ? "+" : "";
    return `${sign}${parsed.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

// Conmutar entre la pestaña del Monitor de Mercado y la Red de Análisis Detallado
function switchTab(tabId) {
    document.querySelectorAll(".tab-pane").forEach(pane => {
        if (pane.id === tabId) {
            pane.style.display = tabId === 'tab-analisis' ? 'flex' : 'block';
            pane.classList.add("active");
        } else {
            pane.style.display = 'none';
            pane.classList.remove("active");
        }
    });
    
    document.querySelectorAll(".tab-btn").forEach(btn => {
        if (btn.getAttribute("data-tab") === tabId) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
}

let loadMonitorTimeout = null;
function triggerMonitorDataReload() {
    if (loadMonitorTimeout) clearTimeout(loadMonitorTimeout);
    loadMonitorTimeout = setTimeout(() => {
        console.log("Recargando monitor de mercado en segundo plano para consistencia...");
        loadMarketMonitorData();
    }, 1000); // 1 segundo de debounce
}

// Cargar y consolidar los datos iniciales para el Monitor de Mercado de la Hoja Principal
async function loadMarketMonitorData() {
    if (!supabaseClient) return;
    
    const ids = Object.keys(tickerMap);
    if (ids.length === 0) return;
    
    // Consulta en paralelo para todos los instrumentos para optimizar velocidad y reducir bloqueos
    await Promise.all(ids.map(async (id) => {
        const inst = tickerMap[id];
        try {
            // Obtener el registro consolidado minuto a minuto más reciente
            const { data: lastData, error: errLast } = await supabaseClient
                .from('market_data_1m')
                .select('close_price, volume, open_price, timestamp')
                .eq('instrument_id', id)
                .order('timestamp', { ascending: false })
                .limit(1);
            
            if (errLast) throw errLast;
            
            if (lastData && lastData.length > 0) {
                const latest = lastData[0];
                // Determinamos los límites del día operativo de la última cotización registrada para este activo
                const activeBounds = getArgentinaDayBounds(latest.timestamp);
                
                let closeVal = parseFloat(latest.close_price);
                let volumeVal = parseInt(latest.volume) || 0;
                let variation = 0;
                let openVal = closeVal;
                
                // Buscamos el precio de cierre anterior a ese día operativo (anterior a activeBounds.start)
                const { data: prevData } = await supabaseClient
                    .from('market_data_1m')
                    .select('close_price')
                    .eq('instrument_id', id)
                    .lt('timestamp', activeBounds.start)
                    .order('timestamp', { ascending: false })
                    .limit(1);
                    
                let basePrice = null;
                if (prevData && prevData.length > 0) {
                    basePrice = parseFloat(prevData[0].close_price);
                } else {
                    // Fallback: Tomamos el primer open_price de ese día operativo
                    const { data: firstData } = await supabaseClient
                        .from('market_data_1m')
                        .select('open_price')
                        .eq('instrument_id', id)
                        .gte('timestamp', activeBounds.start)
                        .lte('timestamp', activeBounds.end)
                        .order('timestamp', { ascending: true })
                        .limit(1);
                        
                    if (firstData && firstData.length > 0) {
                        basePrice = parseFloat(firstData[0].open_price);
                    } else {
                        basePrice = parseFloat(latest.open_price) || closeVal;
                    }
                }
                
                openVal = basePrice;
                variation = basePrice !== 0 ? ((closeVal - basePrice) / basePrice) * 100 : 0;
                
                marketDataMap[id] = {
                    id: id,
                    ticker: inst.ticker,
                    type: inst.type,
                    close_price: closeVal,
                    volume: volumeVal,
                    open_price: openVal,
                    variation: variation
                };
            } else {
                marketDataMap[id] = {
                    id: id,
                    ticker: inst.ticker,
                    type: inst.type,
                    close_price: 0,
                    volume: 0,
                    open_price: 0,
                    variation: 0
                };
            }
        } catch (e) {
            console.error(`Error al cargar datos del monitor para ID ${id}:`, e);
        }
    }));
    
    renderMarketTables();
}

// Renderizar las tablas en vivo del Monitor de Mercado ordenadas por columnas personalizadas y filtradas por búsqueda/volumen
function renderMarketTables() {
    const subyacentesBody = document.getElementById("subyacentes-market-body");
    const opcionesBody = document.getElementById("opciones-market-body");
    
    if (!subyacentesBody || !opcionesBody) return;
    
    subyacentesBody.innerHTML = "";
    opcionesBody.innerHTML = "";
    
    let subyacentesList = [];
    let opcionesList = [];
    
    Object.keys(marketDataMap).forEach(id => {
        const item = marketDataMap[id];
        if (item.type === 'EQUITY') {
            subyacentesList.push(item);
        } else {
            opcionesList.push(item);
        }
    });

    // 1. Actualizar los límites de los sliders de volumen basados en la lista completa
    updateSliderLimits(subyacentesList, opcionesList);
    
    // 2. Filtrar listas por búsqueda y volumen mínimo
    let filteredSubyacentes = subyacentesList.filter(item => {
        const matchesSearch = item.ticker.toUpperCase().includes(subyacentesSearchQuery);
        const matchesVolume = item.volume >= subyacentesVolFilter;
        return matchesSearch && matchesVolume;
    });

    let filteredOpciones = opcionesList.filter(item => {
        const matchesSearch = item.ticker.toUpperCase().includes(opcionesSearchQuery);
        const matchesVolume = item.volume >= opcionesVolFilter;
        return matchesSearch && matchesVolume;
    });

    // Calcular volúmenes máximos de las listas filtradas para graficar las celdas proporcionalmente
    const maxSubyacenteVolValue = Math.max(...filteredSubyacentes.map(item => item.volume), 0) || 1;
    const maxOpcionVolValue = Math.max(...filteredOpciones.map(item => item.volume), 0) || 1;

    // 3. Ordenar listas dinámicamente según la columna y el orden establecido
    sortData(filteredSubyacentes, sortState.subyacentes.column, sortState.subyacentes.order);
    sortData(filteredOpciones, sortState.opciones.column, sortState.opciones.order);

    // 4. Actualizar iconos indicadores y etiquetas de orden en el DOM
    updateSortIcons();
    
    // 5. Renderizar Acciones Subyacentes
    if (filteredSubyacentes.length === 0) {
        subyacentesBody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--color-text-muted);">Sin datos que coincidan con los filtros</td></tr>`;
    } else {
        filteredSubyacentes.forEach(item => {
            const tr = document.createElement("tr");
            tr.style.cursor = "pointer";
            tr.addEventListener("click", () => {
                switchTab("tab-analisis");
                selectTicker(item.id);
            });
            
            const volStr = item.volume.toLocaleString('es-AR');
            const varColor = item.variation >= 0 ? 'var(--color-bid)' : 'var(--color-ask)';
            const varStr = formatPercent(item.variation);
            
            // Barra de progreso horizontal en el fondo de la celda de volumen
            const pct = Math.min((item.volume / maxSubyacenteVolValue) * 100, 100);
            const volBg = `linear-gradient(90deg, rgba(var(--color-accent-rgb), 0.08) 0%, rgba(var(--color-accent-rgb), 0.08) ${pct}%, transparent ${pct}%)`;
            
            tr.innerHTML = `
                <td style="padding: 12px; font-weight: 700; color: var(--color-text-primary);"><i class="fa-solid fa-cubes" style="color: var(--color-accent); font-size:11px; margin-right:8px;"></i>${item.ticker}</td>
                <td style="padding: 12px; text-align: right; font-weight: 600; background: ${volBg}; border-radius: var(--border-radius-sm);">${volStr}</td>
                <td style="padding: 12px; text-align: right; font-weight: 700; color: ${varColor};">${varStr}</td>
            `;
            subyacentesBody.appendChild(tr);
        });
    }
    
    // 6. Renderizar Opciones
    if (filteredOpciones.length === 0) {
        opcionesBody.innerHTML = `<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--color-text-muted);">Sin opciones que coincidan con los filtros</td></tr>`;
    } else {
        filteredOpciones.forEach(item => {
            const tr = document.createElement("tr");
            tr.style.cursor = "pointer";
            tr.addEventListener("click", () => {
                switchTab("tab-analisis");
                selectTicker(item.id);
            });
            
            const volStr = item.volume.toLocaleString('es-AR');
            const varColor = item.variation >= 0 ? 'var(--color-bid)' : 'var(--color-ask)';
            const varStr = formatPercent(item.variation);
            
            // Barra de progreso horizontal en el fondo de la celda de volumen
            const pct = Math.min((item.volume / maxOpcionVolValue) * 100, 100);
            const volBg = `linear-gradient(90deg, rgba(var(--color-accent-rgb), 0.08) 0%, rgba(var(--color-accent-rgb), 0.08) ${pct}%, transparent ${pct}%)`;
            
            tr.innerHTML = `
                <td style="padding: 12px; font-weight: 700; color: var(--color-text-primary);"><i class="fa-solid fa-signature" style="color: rgba(var(--color-accent-rgb), 0.7); font-size:11px; margin-right:8px;"></i>${item.ticker}</td>
                <td style="padding: 12px; text-align: right; font-weight: 600; background: ${volBg}; border-radius: var(--border-radius-sm);">${volStr}</td>
                <td style="padding: 12px; text-align: right; font-weight: 700; color: ${varColor};">${varStr}</td>
            `;
            opcionesBody.appendChild(tr);
        });
    }

    // Actualizar cinta ticker Wall Street al final de renderizar
    updateTickerTape();
}

// Actualizar la cinta corrediza ticker tape de cotizaciones en tiempo real
function updateTickerTape() {
    const tape = document.getElementById("ticker-tape-scroll");
    if (!tape) return;
    
    let itemsList = [];
    Object.keys(marketDataMap).forEach(id => {
        const item = marketDataMap[id];
        if (item.volume > 0) {
            itemsList.push(item);
        }
    });
    
    if (itemsList.length === 0) return;
    
    // Ordenar activos por volumen
    itemsList.sort((a, b) => b.volume - a.volume);
    
    let tapeHtml = "";
    // Duplicar contenido para bucle de marquee infinito sin cortes
    for (let loop = 0; loop < 2; loop++) {
        itemsList.forEach(item => {
            const varColor = item.variation >= 0 ? 'var(--color-bid)' : 'var(--color-ask)';
            const varClass = item.variation >= 0 ? 'fa-caret-up' : 'fa-caret-down';
            tapeHtml += `
                <div class="ticker-tape-item">
                    <span class="ticker-tape-ticker">${item.ticker}</span>
                    <span class="ticker-tape-price">${formatPrice(item.close_price)}</span>
                    <span class="ticker-tape-var" style="color: ${varColor};">
                        <i class="fa-solid ${varClass}" style="margin-right: 3px;"></i>${formatPercent(item.variation)}
                    </span>
                </div>
            `;
        });
    }
    tape.innerHTML = tapeHtml;
}

// Función auxiliar para actualizar límites de los range sliders
function updateSliderLimits(subyacentesList, opcionesList) {
    const subVolMax = Math.max(...subyacentesList.map(item => item.volume), 0) || 100;
    const opVolMax = Math.max(...opcionesList.map(item => item.volume), 0) || 100;

    const subSlider = document.getElementById("subyacentes-vol-slider");
    const opSlider = document.getElementById("opciones-vol-slider");

    if (subSlider) {
        subSlider.max = subVolMax;
        if (parseInt(subSlider.value) > subVolMax) {
            subSlider.value = subVolMax;
            subyacentesVolFilter = subVolMax;
        }
        document.getElementById("subyacentes-vol-label").textContent = parseInt(subSlider.value).toLocaleString('es-AR');
    }

    if (opSlider) {
        opSlider.max = opVolMax;
        if (parseInt(opSlider.value) > opVolMax) {
            opSlider.value = opVolMax;
            opcionesVolFilter = opVolMax;
        }
        document.getElementById("opciones-vol-label").textContent = parseInt(opSlider.value).toLocaleString('es-AR');
    }
}

// Función auxiliar para ordenar listas de datos
function sortData(list, column, order) {
    list.sort((a, b) => {
        let valA, valB;
        if (column === 'ticker') {
            valA = a.ticker.toUpperCase();
            valB = b.ticker.toUpperCase();
            if (valA < valB) return order === 'asc' ? -1 : 1;
            if (valA > valB) return order === 'asc' ? 1 : -1;
            return 0;
        } else if (column === 'variation') {
            valA = parseFloat(a.variation) || 0;
            valB = parseFloat(b.variation) || 0;
        } else {
            valA = parseInt(a.volume) || 0;
            valB = parseInt(b.volume) || 0;
        }
        return order === 'asc' ? valA - valB : valB - valA;
    });
}

// Función auxiliar para actualizar los iconos e indicadores visuales de ordenación en el DOM
function updateSortIcons() {
    const subTickerIcon = document.getElementById("sort-icon-subyacente-ticker");
    const subVolIcon = document.getElementById("sort-icon-subyacente-vol");
    const subVarIcon = document.getElementById("sort-icon-subyacente-var");
    
    if (subTickerIcon && subVolIcon && subVarIcon) {
        subTickerIcon.className = "fa-solid fa-sort sort-icon";
        subTickerIcon.style.color = "";
        subVolIcon.className = "fa-solid fa-sort sort-icon";
        subVolIcon.style.color = "";
        subVarIcon.className = "fa-solid fa-sort sort-icon";
        subVarIcon.style.color = "";
        
        const activeSub = sortState.subyacentes;
        const icon = activeSub.column === 'ticker' ? subTickerIcon : (activeSub.column === 'variation' ? subVarIcon : subVolIcon);
        icon.className = `fa-solid fa-sort-${activeSub.order === 'asc' ? 'up' : 'down'} sort-icon`;
        icon.style.color = "var(--color-accent)";
        
        const labelMapping = { ticker: 'Activo', volume: 'Vol. Nom.', variation: 'Var. %' };
        const orderMapping = { asc: 'Asc', desc: 'Desc' };
        document.getElementById("subyacentes-order-label").textContent = `Ordenado por ${labelMapping[activeSub.column]} (${orderMapping[activeSub.order]})`;
    }

    const opTickerIcon = document.getElementById("sort-icon-opcion-ticker");
    const opVolIcon = document.getElementById("sort-icon-opcion-vol");
    const opVarIcon = document.getElementById("sort-icon-opcion-var");

    if (opTickerIcon && opVolIcon && opVarIcon) {
        opTickerIcon.className = "fa-solid fa-sort sort-icon";
        opTickerIcon.style.color = "";
        opVolIcon.className = "fa-solid fa-sort sort-icon";
        opVolIcon.style.color = "";
        opVarIcon.className = "fa-solid fa-sort sort-icon";
        opVarIcon.style.color = "";

        const activeOp = sortState.opciones;
        const icon = activeOp.column === 'ticker' ? opTickerIcon : (activeOp.column === 'variation' ? opVarIcon : opVolIcon);
        icon.className = `fa-solid fa-sort-${activeOp.order === 'asc' ? 'up' : 'down'} sort-icon`;
        icon.style.color = "var(--color-accent)";

        const labelMapping = { ticker: 'Opción', volume: 'Vol. Nom.', variation: 'Var. %' };
        const orderMapping = { asc: 'Asc', desc: 'Desc' };
        document.getElementById("opciones-order-label").textContent = `Ordenado por ${labelMapping[activeOp.column]} (${orderMapping[activeOp.order]})`;
    }
}

// Helper para parsear la fecha de la base de datos (UTC) a la hora local del navegador (Argentina/etc.)
function parseTimestampToLocalString(timestampStr) {
    if (!timestampStr) return "-";
    
    // Reemplazar espacios por "T" para asegurar compatibilidad ISO
    let tStr = timestampStr.replace(" ", "T");
    
    // Forzar interpretación UTC reemplazando offsets de base de datos
    if (tStr.endsWith("+00")) {
        tStr = tStr.substring(0, tStr.length - 3) + "Z";
    } else if (tStr.endsWith("+00:00")) {
        tStr = tStr.substring(0, tStr.length - 6) + "Z";
    } else if (!tStr.endsWith("Z") && !tStr.includes("+") && !tStr.includes("-")) {
        tStr += "Z";
    }
    
    try {
        const date = new Date(tStr);
        return date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + " hs";
    } catch (e) {
        console.error("Error al formatear timestamp:", e);
        return timestampStr;
    }
}

// Obtener los límites de inicio y fin del día calendario argentino (UTC-3) en formato ISO UTC
function getArgentinaDayBounds(timestampStr) {
    const date = timestampStr ? new Date(timestampStr) : new Date();
    
    // Obtener la fecha local en formato YYYY-MM-DD para la zona de Argentina
    const dateStr = new Intl.DateTimeFormat('fr-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
    
    // Calcular el día de mañana en formato YYYY-MM-DD
    const parts = dateStr.split('-');
    const localDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const tomorrow = new Date(localDate.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = new Intl.DateTimeFormat('fr-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(tomorrow);
    
    // En Argentina (UTC-3):
    // El inicio de día (00:00:00-03:00) es 03:00:00Z UTC
    // El fin de día (23:59:59-03:00) es 02:59:59Z UTC del día siguiente
    return {
        start: `${dateStr}T03:00:00Z`,
        end: `${tomorrowStr}T02:59:59Z`
    };
}

// Cargar precios históricos de la base de datos para los nodos del tablero
async function loadInitialPrices() {
    if (!supabaseClient) return;
    const subyacentesIds = [1, 2, 10, 11]; // GGAL, PAMP, YPFD, METR
    
    for (const subId of subyacentesIds) {
        try {
            const { data, error } = await supabaseClient
                .from('market_data_1m')
                .select('close_price')
                .eq('instrument_id', subId)
                .order('timestamp', { ascending: false })
                .limit(1);
            
            if (data && data.length > 0) {
                const priceLabel = document.getElementById(`node-price-${subId}`);
                if (priceLabel) {
                    priceLabel.textContent = formatPrice(data[0].close_price);
                }
            }
        } catch (e) {
            console.error(`Error cargando precio inicial para ID ${subId}:`, e);
        }
    }
}

// 2. Inicialización
document.addEventListener("DOMContentLoaded", () => {
    initSupabase();
    loadActiveTickers();
    setupEventListeners();
    setupFallbackPolling();
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
        let equities = [];
        let options = [];

        data.forEach(item => {
            const inst = item.instruments;
            if (!inst) return;
            
            count++;
            tickerMap[inst.id] = {
                ticker: inst.ticker,
                type: inst.type,
                underlying_id: inst.underlying_id
            };

            if (inst.type === 'EQUITY') {
                equities.push(inst);
            } else {
                options.push(inst);
            }
        });

        // Ordenar equities
        equities.sort((a, b) => a.ticker.localeCompare(b.ticker));

        equities.forEach(eq => {
            // Contenedor del grupo
            const groupEl = document.createElement("div");
            groupEl.classList.add("underlying-group");
            
            // Fila del subyacente
            const eqEl = document.createElement("div");
            eqEl.classList.add("ticker-item", "underlying-item");
            eqEl.setAttribute("data-id", eq.id);
            eqEl.setAttribute("data-ticker", eq.ticker);
            
            eqEl.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <i class="fa-solid fa-cubes" style="color: var(--color-accent); font-size: 13px;"></i>
                    <div>
                        <div class="ticker-name" style="font-weight: 700;">${eq.ticker}</div>
                        <div style="font-size: 8px; color: var(--color-text-muted); font-weight:600; text-transform: uppercase;">Subyacente</div>
                    </div>
                </div>
                <div class="ticker-price" id="ticker-price-${eq.id}">-</div>
            `;
            
            eqEl.addEventListener("click", () => selectTicker(eq.id));
            groupEl.appendChild(eqEl);
            
            // Contenedor de opciones
            const optsContainer = document.createElement("div");
            optsContainer.classList.add("options-container");
            
            // Buscar opciones asociadas a este subyacente
            const associatedOpts = options.filter(opt => opt.underlying_id === eq.id);
            associatedOpts.sort((a, b) => a.ticker.localeCompare(b.ticker));
            
            if (associatedOpts.length > 0) {
                associatedOpts.forEach(opt => {
                    const optEl = document.createElement("div");
                    optEl.classList.add("ticker-item", "option-item");
                    optEl.setAttribute("data-id", opt.id);
                    optEl.setAttribute("data-ticker", opt.ticker);
                    
                    optEl.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <i class="fa-solid fa-turn-up" style="transform: rotate(90deg); color: var(--color-text-muted); font-size: 10px; margin-right: 2px;"></i>
                            <i class="fa-solid fa-signature" style="color: rgba(var(--color-accent-rgb), 0.7); font-size: 11px;"></i>
                            <div>
                                <div class="ticker-name" style="font-size: 12px; font-weight: 600;">${opt.ticker}</div>
                                <div style="font-size: 8px; color: var(--color-text-muted); font-weight:500; text-transform: uppercase;">Opción</div>
                            </div>
                        </div>
                        <div class="ticker-price" style="font-size: 12px;" id="ticker-price-${opt.id}">-</div>
                    `;
                    
                    optEl.addEventListener("click", (e) => {
                        e.stopPropagation();
                        selectTicker(opt.id);
                    });
                    optsContainer.appendChild(optEl);
                });
                groupEl.appendChild(optsContainer);
            }
            
            listContainer.appendChild(groupEl);
        });

        // Opciones sin subyacente asignado
        const unlinkedOpts = options.filter(opt => !opt.underlying_id || !equities.some(eq => eq.id === opt.underlying_id));
        if (unlinkedOpts.length > 0) {
            const groupEl = document.createElement("div");
            groupEl.classList.add("underlying-group");
            
            const titleEl = document.createElement("div");
            titleEl.style.padding = "4px 8px";
            titleEl.style.fontSize = "9px";
            titleEl.style.color = "var(--color-text-muted)";
            titleEl.style.fontWeight = "700";
            titleEl.textContent = "OTRAS OPCIONES";
            groupEl.appendChild(titleEl);
            
            unlinkedOpts.forEach(opt => {
                const optEl = document.createElement("div");
                optEl.classList.add("ticker-item", "option-item");
                optEl.setAttribute("data-id", opt.id);
                optEl.setAttribute("data-ticker", opt.ticker);
                
                optEl.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <i class="fa-solid fa-signature" style="color: rgba(var(--color-accent-rgb), 0.7); font-size: 11px;"></i>
                        <div>
                            <div class="ticker-name" style="font-size: 12px; font-weight: 600;">${opt.ticker}</div>
                            <div style="font-size: 8px; color: var(--color-text-muted); font-weight:500; text-transform: uppercase;">Opción</div>
                        </div>
                    </div>
                    <div class="ticker-price" style="font-size: 12px;" id="ticker-price-${opt.id}">-</div>
                `;
                
                optEl.addEventListener("click", () => selectTicker(opt.id));
                groupEl.appendChild(optEl);
            });
            listContainer.appendChild(groupEl);
        }

        document.getElementById("whitelist-count").textContent = count;
        // Cargar precios iniciales en el tablero de red
        loadInitialPrices();
        // Cargar datos consolidados para el Monitor de Mercado (Hoja Principal)
        loadMarketMonitorData();

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

// Crear fila HTML de datos
function createTableRow(row) {
    const tr = document.createElement("tr");
    tr.style.borderBottom = "1px solid var(--border-color)";
    tr.style.transition = "background-color 0.2s";
    
    // Efecto hover
    tr.addEventListener("mouseenter", () => tr.style.backgroundColor = "rgba(255, 255, 255, 0.03)");
    tr.addEventListener("mouseleave", () => tr.style.backgroundColor = "transparent");

    const dateStr = parseTimestampToLocalString(row.timestamp);
    
    const close = formatPriceRaw(row.close_price);
    const vol = parseInt(row.volume).toLocaleString('es-AR');
    
    const bid = formatPrice(row.bid_price);
    const bidSize = row.bid_size ? parseInt(row.bid_size).toLocaleString('es-AR') : "-";
    const ask = formatPrice(row.ask_price);
    const askSize = row.ask_size ? parseInt(row.ask_size).toLocaleString('es-AR') : "-";
    
    const ops = row.operations ? parseInt(row.operations).toLocaleString('es-AR') : "-";
    const turnover = row.turnover ? `$${parseFloat(row.turnover).toLocaleString('es-AR', {maximumFractionDigits: 0})}` : "-";
    const oi = row.open_interest ? parseInt(row.open_interest).toLocaleString('es-AR') : "-";

    tr.innerHTML = `
        <td style="padding: 12px; font-weight: 500; color: var(--color-text-secondary);">${dateStr}</td>
        <td style="padding: 12px; text-align: right; font-weight: 700; color: var(--color-accent);">${close}</td>
        <td style="padding: 12px; text-align: right;">${vol}</td>
        <td style="padding: 12px; text-align: right; color: var(--color-bid); font-weight: 500;">${bid} <span style="font-size: 10px; color: var(--color-text-muted); font-weight: 400;">(${bidSize})</span></td>
        <td style="padding: 12px; text-align: right; color: var(--color-ask); font-weight: 500;">${ask} <span style="font-size: 10px; color: var(--color-text-muted); font-weight: 400;">(${askSize})</span></td>
        <td style="padding: 12px; text-align: right;">${ops}</td>
        <td style="padding: 12px; text-align: right; color: var(--color-text-secondary);">${turnover}</td>
        <td style="padding: 12px; text-align: right; font-weight: 500;">${oi}</td>
    `;
    return tr;
}

// Seleccionar un Ticker del Panel Lateral y Cargar su Historial en la Tabla
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

    // Actualizar nodos del tablero de red
    document.querySelectorAll(".nodo-red").forEach(nodo => {
        nodo.classList.remove("active");
    });
    document.querySelectorAll(".node-cruce").forEach(line => {
        line.classList.remove("active");
    });

    const isSubyacente = asset.type === 'EQUITY';
    if (isSubyacente) {
        const nodoActivo = document.getElementById(`node-${id}`);
        if (nodoActivo) nodoActivo.classList.add("active");
        
        const lineActiva = document.getElementById(`line-${id}`);
        if (lineActiva) lineActiva.classList.add("active");
    } else {
        // Si es una opción, iluminar el nodo del subyacente padre
        const subId = asset.underlying_id;
        const nodoActivo = document.getElementById(`node-${subId}`);
        if (nodoActivo) nodoActivo.classList.add("active");
        
        const lineActiva = document.getElementById(`line-${subId}`);
        if (lineActiva) lineActiva.classList.add("active");
    }

    // Actualizar nodo central destacado
    document.getElementById("central-ticker").textContent = asset.ticker;
    document.getElementById("central-price").textContent = "$-";

    // Mostrar el encabezado de detalles
    const detailHeader = document.getElementById("selected-ticker-header");
    detailHeader.style.display = "flex";
    document.getElementById("selected-ticker-name").textContent = asset.ticker;
    document.getElementById("selected-ticker-type").textContent = asset.type === 'OPTION' ? 'Opción Financiera' : 'Acción Líder (Subyacente)';

    // Consultar el historial de market_data_1m (Últimos 50 registros)
    try {
        const { data, error } = await supabaseClient
            .from('market_data_1m')
            .select('*')
            .eq('instrument_id', id)
            .order('timestamp', { ascending: false })
            .limit(50);

        if (error) throw error;

        const tableBody = document.getElementById("data-table-body");
        tableBody.innerHTML = "";

        if (data.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="8" style="padding: 40px; text-align: center; color: var(--color-text-muted);">
                        <i class="fa-solid fa-folder-open" style="font-size: 24px; margin-bottom: 10px; display: block; color: var(--border-color);"></i>
                        No hay datos registrados aún para este activo.
                    </td>
                </tr>
            `;
        } else {
            data.forEach(row => {
                const tr = createTableRow(row);
                tableBody.appendChild(tr);
            });
        }

        // Actualizar métricas del panel derecho e inferior
        if (data.length > 0) {
            const lastRow = data[0]; // La primera fila es la más reciente por el orderby DESC
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
            async (payload) => {
                const newRow = payload.new;
                
                // 1. Actualizar el precio rápido en el panel lateral de tickers
                const priceLabel = document.getElementById(`ticker-price-${newRow.instrument_id}`);
                if (priceLabel) {
                    priceLabel.textContent = formatPrice(newRow.close_price);
                    priceLabel.style.color = parseFloat(newRow.close_price) >= parseFloat(newRow.open_price) ? 'var(--color-bid)' : 'var(--color-ask)';
                }

                // 2. Actualizar el precio en el nodo del tablero si corresponde
                const subNodePrice = document.getElementById(`node-price-${newRow.instrument_id}`);
                if (subNodePrice) {
                    subNodePrice.textContent = formatPrice(newRow.close_price);
                }

                // 3. Actualizar memoria local en tiempo real sin saturar con consultas HTTP redundantes
                const item = marketDataMap[newRow.instrument_id];
                if (item) {
                    item.close_price = parseFloat(newRow.close_price);
                    item.volume = parseInt(newRow.volume) || 0;
                    
                    // El basePrice guardado está en item.open_price (cierre anterior o primer apertura)
                    const basePrice = item.open_price || item.close_price;
                    item.variation = basePrice !== 0 ? ((item.close_price - basePrice) / basePrice) * 100 : 0;
                    
                    // Renderizar tablas inmediatamente para reactividad instantánea 0ms latencia
                    renderMarketTables();
                }

                // Programar una recarga en segundo plano debouncada para consistencia
                triggerMonitorDataReload();

                // 4. Si es el ticker seleccionado actualmente, actualizamos la tabla, los paneles y el nodo central
                if (currentTicker && newRow.instrument_id == currentTicker.id) {
                    const tableBody = document.getElementById("data-table-body");
                    
                    // Remover placeholder si está presente
                    const placeholder = document.getElementById("table-placeholder");
                    if (placeholder) {
                        placeholder.remove();
                    }
                    
                    // Si ya había una fila de "No hay datos", vaciamos
                    if (tableBody.children.length === 1 && tableBody.children[0].cells.length === 1) {
                        tableBody.innerHTML = "";
                    }

                    // Crear e insertar la nueva fila arriba de la tabla
                    const tr = createTableRow(newRow);
                    tableBody.insertBefore(tr, tableBody.firstChild);
                    
                    // Limitar a las últimas 50 filas
                    if (tableBody.children.length > 50) {
                        tableBody.removeChild(tableBody.lastChild);
                    }

                    // Actualizar nodo central destacado
                    document.getElementById("central-price").textContent = formatPrice(newRow.close_price);

                    // Actualizar paneles visuales
                    updateDetailPanels(newRow);
                }
            }
        )
        .subscribe();
}

// Fallback de refresco periódico por polling en caso de que los WebSockets fallen o estén desactivados
function setupFallbackPolling() {
    setInterval(async () => {
        console.log("Sincronizando monitor de mercado con Supabase...");
        await loadMarketMonitorData();
        if (currentTicker && currentTicker.id) {
            // Refrescar el histórico y detalles si hay un activo seleccionado
            try {
                const { data, error } = await supabaseClient
                    .from('market_data_1m')
                    .select('*')
                    .eq('instrument_id', currentTicker.id)
                    .order('timestamp', { ascending: false })
                    .limit(50);

                if (!error && data && data.length > 0) {
                    const tableBody = document.getElementById("data-table-body");
                    // Guardar posición de scroll actual del contenedor para evitar saltos molestos al usuario
                    const scrollPos = tableBody.parentElement ? tableBody.parentElement.scrollTop : 0;
                    
                    tableBody.innerHTML = "";
                    data.forEach(row => {
                        const tr = createTableRow(row);
                        tableBody.appendChild(tr);
                    });
                    
                    if (tableBody.parentElement) {
                        tableBody.parentElement.scrollTop = scrollPos;
                    }
                    
                    // Actualizar los paneles de la derecha e inferior con el registro más reciente
                    updateDetailPanels(data[0]);
                }
            } catch (err) {
                console.error("Error en polling histórico:", err);
            }
        }
    }, 30000); // Sincroniza cada 30 segundos de forma pasiva
}

function updateDetailPanels(row) {
    const formattedPrice = formatPrice(row.close_price);
    
    // Header
    document.getElementById("header-last-price").textContent = formattedPrice;
    document.getElementById("header-volume").textContent = parseInt(row.volume).toLocaleString('es-AR');
    
    const fullTimeStr = parseTimestampToLocalString(row.timestamp);
    const dateStr = fullTimeStr.substring(0, 8); // Tomar HH:MM:SS
    document.getElementById("header-time").textContent = `${dateStr} hs`;

    // Actualizar el nodo central destacado con el precio en tiempo real
    if (currentTicker && row.instrument_id == currentTicker.id) {
        document.getElementById("central-price").textContent = formattedPrice;
    }

    // Actualizar el nodo correspondiente del tablero
    const subNodePrice = document.getElementById(`node-price-${row.instrument_id}`);
    if (subNodePrice) {
        subNodePrice.textContent = formattedPrice;
    }

    // Orderbook / Bid & Ask
    const bidVal = formatPrice(row.bid_price);
    const askVal = formatPrice(row.ask_price);
    
    document.getElementById("bid-price").textContent = bidVal;
    document.getElementById("ask-price").textContent = askVal;

    // Calcular Spread %
    if (row.bid_price && row.ask_price) {
        const spread = parseFloat(row.ask_price) - parseFloat(row.bid_price);
        const spreadPct = (spread / parseFloat(row.bid_price)) * 100;
        document.getElementById("spread-pct").textContent = `${spreadPct.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
    } else {
        document.getElementById("spread-pct").textContent = "-%";
    }

    // Cuadrícula OHLC inferior
    document.getElementById("ohlc-open").textContent = formatPrice(row.open_price);
    document.getElementById("ohlc-high").textContent = formatPrice(row.high_price);
    document.getElementById("ohlc-low").textContent = formatPrice(row.low_price);
    document.getElementById("ohlc-close").textContent = formatPrice(row.close_price);
    
    // Métricas Avanzadas de pyRofex
    document.getElementById("rofex-bid-size").textContent = row.bid_size ? parseInt(row.bid_size).toLocaleString('es-AR') : "-";
    document.getElementById("rofex-ask-size").textContent = row.ask_size ? parseInt(row.ask_size).toLocaleString('es-AR') : "-";
    document.getElementById("rofex-last-size").textContent = row.last_size ? parseInt(row.last_size).toLocaleString('es-AR') : "-";
    document.getElementById("rofex-operations").textContent = row.operations ? parseInt(row.operations).toLocaleString('es-AR') : "-";
    document.getElementById("rofex-turnover").textContent = row.turnover ? `$${parseFloat(row.turnover).toLocaleString('es-AR', {minimumFractionDigits: 0, maximumFractionDigits: 0})}` : "-";
    document.getElementById("rofex-open-interest").textContent = row.open_interest ? parseInt(row.open_interest).toLocaleString('es-AR') : "-";

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
        document.getElementById("rofex-bid-size").textContent = "-";
    document.getElementById("rofex-ask-size").textContent = "-";
    document.getElementById("rofex-last-size").textContent = "-";
    document.getElementById("rofex-operations").textContent = "-";
    document.getElementById("rofex-turnover").textContent = "-";
    document.getElementById("rofex-open-interest").textContent = "-";
}

// Configurar buscador y clicks del panel lateral, tablero de red, pestañas, cabeceras de ordenación y sliders de tablas
function setupEventListeners() {
    // Configurar clicks en los botones de pestañas
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const tabId = btn.getAttribute("data-tab");
            switchTab(tabId);
        });
    });

    // Configurar clicks en los nodos del tablero de red
    document.querySelectorAll(".nodo-red").forEach(nodo => {
        const id = nodo.getAttribute("data-id");
        if (id) {
            nodo.addEventListener("click", () => {
                selectTicker(parseInt(id));
            });
        }
    });

    // Buscador del panel lateral
    const searchInput = document.getElementById("ticker-search");
    searchInput.addEventListener("input", (e) => {
        const query = e.target.value.trim().toUpperCase();
        
        if (!query) {
            document.querySelectorAll(".underlying-group").forEach(group => group.style.display = "flex");
            document.querySelectorAll(".ticker-item").forEach(item => item.style.display = "flex");
            return;
        }

        document.querySelectorAll(".underlying-group").forEach(group => {
            let groupHasMatch = false;
            
            const eqItem = group.querySelector(".underlying-item");
            let eqMatches = false;
            if (eqItem) {
                const ticker = eqItem.getAttribute("data-ticker");
                eqMatches = ticker.includes(query);
                if (eqMatches) {
                    eqItem.style.display = "flex";
                    groupHasMatch = true;
                } else {
                    eqItem.style.display = "none";
                }
            }
            
            const optItems = group.querySelectorAll(".option-item");
            optItems.forEach(opt => {
                const ticker = opt.getAttribute("data-ticker");
                const optMatches = ticker.includes(query);
                if (optMatches || eqMatches) {
                    opt.style.display = "flex";
                    groupHasMatch = true;
                } else {
                    opt.style.display = "none";
                }
            });
            
            if (groupHasMatch) {
                group.style.display = "flex";
            } else {
                group.style.display = "none";
            }
        });
    });

    // --- NUEVOS CONTROLADORES DE FILTRADO Y ORDENACIÓN ---

    // 1. Buscadores individuales de las tablas del monitor
    const subSearch = document.getElementById("subyacentes-search");
    if (subSearch) {
        subSearch.addEventListener("input", (e) => {
            subyacentesSearchQuery = e.target.value.trim().toUpperCase();
            renderMarketTables();
        });
    }

    const opSearch = document.getElementById("opciones-search");
    if (opSearch) {
        opSearch.addEventListener("input", (e) => {
            opcionesSearchQuery = e.target.value.trim().toUpperCase();
            renderMarketTables();
        });
    }

    // 2. Sliders (filtros de volumen mínimo) de las tablas del monitor
    const subSlider = document.getElementById("subyacentes-vol-slider");
    if (subSlider) {
        subSlider.addEventListener("input", (e) => {
            const val = parseInt(e.target.value);
            subyacentesVolFilter = val;
            document.getElementById("subyacentes-vol-label").textContent = val.toLocaleString('es-AR');
            renderMarketTables();
        });
    }

    const opSlider = document.getElementById("opciones-vol-slider");
    if (opSlider) {
        opSlider.addEventListener("input", (e) => {
            const val = parseInt(e.target.value);
            opcionesVolFilter = val;
            document.getElementById("opciones-vol-label").textContent = val.toLocaleString('es-AR');
            renderMarketTables();
        });
    }

    // 3. Manejadores de ordenación por clic en cabeceras - Tabla Subyacentes
    const handleSortSubyacentes = (column) => {
        if (sortState.subyacentes.column === column) {
            sortState.subyacentes.order = sortState.subyacentes.order === 'asc' ? 'desc' : 'asc';
        } else {
            sortState.subyacentes.column = column;
            sortState.subyacentes.order = 'desc'; // Por defecto desc para datos financieros
        }
        renderMarketTables();
    };

    const thSubTicker = document.getElementById("th-subyacente-ticker");
    if (thSubTicker) thSubTicker.addEventListener("click", () => handleSortSubyacentes('ticker'));

    const thSubVol = document.getElementById("th-subyacente-vol");
    if (thSubVol) thSubVol.addEventListener("click", () => handleSortSubyacentes('volume'));

    const thSubVar = document.getElementById("th-subyacente-var");
    if (thSubVar) thSubVar.addEventListener("click", () => handleSortSubyacentes('variation'));

    // 4. Manejadores de ordenación por clic en cabeceras - Tabla Opciones
    const handleSortOpciones = (column) => {
        if (sortState.opciones.column === column) {
            sortState.opciones.order = sortState.opciones.order === 'asc' ? 'desc' : 'asc';
        } else {
            sortState.opciones.column = column;
            sortState.opciones.order = 'desc';
        }
        renderMarketTables();
    };

    const thOpTicker = document.getElementById("th-opcion-ticker");
    if (thOpTicker) thOpTicker.addEventListener("click", () => handleSortOpciones('ticker'));

    const thOpVol = document.getElementById("th-opcion-vol");
    if (thOpVol) thOpVol.addEventListener("click", () => handleSortOpciones('volume'));

    const thOpVar = document.getElementById("th-opcion-var");
    if (thOpVar) thOpVar.addEventListener("click", () => handleSortOpciones('variation'));
}
