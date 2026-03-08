# ProphetLabs — Plan de Integración: Kalshi + Predict APIs
## Documento de Arquitectura y Ejecución para Sonnet

---

## 1. ESTADO ACTUAL DEL PROYECTO

### Archivo: `prophetlabs_23_B_W_ORANGE_BLUE_AURORA_REV22.jsx`
- **2,729 líneas** — Single-file React component
- **Plataformas definidas**: Polymarket, Opinion Labs, Kalshi, Predict (ya existen en `PLATFORMS` como mock)
- **Datos**: 10 mercados mock con precios simulados para las 4 plataformas
- **UI**: Landing page + Dashboard con glassmorphism, aurora effects, dark theme
- **Funcionalidades**: Filtros, alertas, trade calculator, order book depth chart, market pair selector, matrix view, keyboard shortcuts, persistent storage

### Lo que YA existe pero es MOCK:
```javascript
// Línea 5-10: PLATFORMS ya incluye kalshi y predict
const PLATFORMS = {
  polymarket: { key:"polymarket", ..., fee:0.0217, settlement:"On-chain (Polygon)", trust:92 },
  opinion:    { key:"opinion", ..., fee:0, settlement:"Centralized escrow", trust:78 },
  kalshi:     { key:"kalshi", ..., fee:0.01, settlement:"CFTC-regulated exchange", trust:88 },
  predict:    { key:"predict", ..., fee:0.015, settlement:"Decentralized protocol", trust:74 },
};

// Línea 13-23: MOCK data ya tiene precios para las 4 plataformas
// prices: { polymarket:{yes,no}, opinion:{yes,no}, kalshi:{yes,no}, predict:{yes,no} }
```

### Lo que NECESITA cambiar:
Los datos son completamente falsos. El pair selector funciona pero con datos mock. No hay conexión real a ninguna API.

---

## 2. DOCUMENTACIÓN DE APIs

### 2.1 KALSHI API

**Base URL**: `https://api.elections.kalshi.com/trade-api/v2`
(Nota: a pesar del subdominio "elections", sirve TODOS los mercados)

**Autenticación**:
- Endpoints públicos de market data: NO requieren auth
- Trading/portfolio: Requieren RSA-PSS signed API keys (tokens expiran cada 30 min)

**Endpoints clave para ProphetLabs**:

| Endpoint | Método | Auth | Uso |
|----------|--------|------|-----|
| `/markets` | GET | No | Listar mercados con precios bid/ask |
| `/markets/{ticker}` | GET | No | Detalle de un mercado específico |
| `/events` | GET | No | Eventos (agrupaciones de mercados) |
| `/events?with_nested_markets=true` | GET | No | Eventos con mercados anidados |
| `/markets/trades` | GET | No | Historial de trades |
| `/markets/{ticker}/orderbook` | GET | No | Order book (solo bids, YES/NO recíproco) |
| `/markets/{ticker}/candlesticks` | GET | No | Datos históricos de velas |

**Esquema de respuesta de mercado** (campos relevantes):
```json
{
  "ticker": "KXBTC-150K-2026",
  "event_ticker": "KXBTC2026",
  "title": "Bitcoin above $150K by Dec 2026",
  "status": "open",
  "yes_bid": 38,           // en centavos (LEGACY — se eliminará marzo 2026)
  "yes_bid_dollars": "0.38",  // USAR ESTE (formato string)
  "yes_ask": 40,
  "yes_ask_dollars": "0.40",
  "no_bid": 60,
  "no_bid_dollars": "0.60",
  "no_ask": 62,
  "no_ask_dollars": "0.62",
  "last_price": 39,
  "last_price_dollars": "0.39",
  "volume": 123456,
  "volume_24h": 5000,
  "volume_24h_fp": "5000.00",
  "expiration_time": "2026-12-31T00:00:00Z",
  "open_interest": 45000,
  "category": "Crypto"
}
```

**Paginación**: Cursor-based (`limit` 1-1000, default 100, campo `cursor`)

**Rate limits**: Documentados en `/getting_started/rate_limits`

**Order book**: Solo retorna bids (no asks) por la naturaleza binaria. YES bid = complemento de NO ask.

**IMPORTANTE (Changelog marzo 2026)**:
- Campos enteros legacy (yes_bid, no_bid, etc.) se eliminarán el 12/03/2026
- Migrar a campos `_dollars` (string) y `_fp` (string con decimales)
- Fractional trading roll-out por mercado desde 09/03/2026

**WebSocket**: `wss://api.elections.kalshi.com/trade-api/v2/ws` — Canales: `ticker`, `orderbook_delta`, `market_lifecycle_v2`

---

### 2.2 PREDICT API

**Base URL**: `https://api.predict.fun` (BNB Mainnet, requiere API key)
**Testnet**: `https://api-testnet.predict.fun` (no requiere API key)

**Autenticación**:
- Header: `x-api-key: <api-key>`
- JWT Bearer para operaciones autenticadas
- API key se solicita vía Discord

**Endpoints clave para ProphetLabs**:

| Endpoint | Método | Auth | Uso |
|----------|--------|------|-----|
| `/v1/markets` | GET | API Key | Listar mercados |
| `/v1/markets/{id}` | GET | API Key | Mercado por ID |
| `/v1/markets/{id}/orderbook` | GET | API Key | Order book |
| `/v1/markets/{id}/statistics` | GET | API Key | Estadísticas |
| `/v1/markets/{id}/last-sale` | GET | API Key | Última venta |
| `/v1/categories` | GET | API Key | Categorías |
| `/v1/search` | GET | API Key | Buscar mercados y categorías |

**Order book** (estructura):
```json
{
  "success": true,
  "data": {
    "marketId": 1,
    "updateTimestampMs": 1727910141000,
    "asks": [[0.492, 30192.26], [0.493, 20003]],  // [price, quantity]
    "bids": [[0.491, 303518.1], [0.49, 1365.44]]   // [price, quantity]
  }
}
```
- Precios basados en YES outcome
- Para NO: `price_no = 1 - price_yes` (a la precisión decimal del mercado)

**Rate limit**: 240 requests/minuto (mainnet con API key)

**WebSocket**: `wss://ws.predict.fun/ws?apiKey=your-key`
- Heartbeat cada 15 segundos (responder con mismo timestamp)
- Topics: market data, orderbook, price updates (públicos), wallet events (privado)

**SDKs disponibles**:
- TypeScript: `@predictdotfun/sdk`
- Python: `predict-sdk`

---

## 3. PLAN DE INTEGRACIÓN — PASO A PASO

### FASE 1: Capa de Datos (Service Layer)

**Objetivo**: Crear un módulo de servicios que abstraiga las llamadas a ambas APIs.

#### 3.1.1 Crear `ApiService` (nuevo módulo/sección al inicio del archivo)

```javascript
// ─── API SERVICES ─────────────────────────────────────────
const API_CONFIG = {
  kalshi: {
    baseUrl: "https://api.elections.kalshi.com/trade-api/v2",
    // No auth needed for public market data
  },
  predict: {
    baseUrl: "https://api.predict.fun",
    // API key needed — user provides via settings
    apiKey: null, // Set from user preferences
  }
};

// Kalshi market data fetcher
async function fetchKalshiMarkets(options = {}) {
  const { status = "open", limit = 200, cursor = null, category = null } = options;
  const params = new URLSearchParams({ limit, status });
  if (cursor) params.set("cursor", cursor);
  if (category) params.set("category", category);
  
  const res = await fetch(`${API_CONFIG.kalshi.baseUrl}/markets?${params}`);
  if (!res.ok) throw new Error(`Kalshi API error: ${res.status}`);
  return res.json();
}

async function fetchKalshiOrderbook(ticker) {
  const res = await fetch(`${API_CONFIG.kalshi.baseUrl}/markets/${ticker}/orderbook`);
  if (!res.ok) throw new Error(`Kalshi orderbook error: ${res.status}`);
  return res.json();
}

// Predict market data fetcher
async function fetchPredictMarkets(apiKey, options = {}) {
  const { first = 100, after = null } = options;
  const params = new URLSearchParams();
  if (first) params.set("first", first);
  if (after) params.set("after", after);
  
  const res = await fetch(`${API_CONFIG.predict.baseUrl}/v1/markets?${params}`, {
    headers: { "x-api-key": apiKey }
  });
  if (!res.ok) throw new Error(`Predict API error: ${res.status}`);
  return res.json();
}

async function fetchPredictOrderbook(apiKey, marketId) {
  const res = await fetch(`${API_CONFIG.predict.baseUrl}/v1/markets/${marketId}/orderbook`, {
    headers: { "x-api-key": apiKey }
  });
  if (!res.ok) throw new Error(`Predict orderbook error: ${res.status}`);
  return res.json();
}
```

#### 3.1.2 Market Matching Engine

El desafío principal: **vincular mercados equivalentes entre plataformas**. Los mercados sobre el mismo evento tienen títulos diferentes en cada plataforma.

```javascript
// ─── MARKET MATCHER ──────────────────────────────────────
// Strategy: fuzzy match on event titles + category + expiry date

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function calculateSimilarity(a, b) {
  // Jaccard similarity on word sets
  const setA = new Set(normalizeTitle(a).split(" "));
  const setB = new Set(normalizeTitle(b).split(" "));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

function matchMarkets(kalshiMarkets, predictMarkets, threshold = 0.4) {
  const matched = [];
  
  for (const km of kalshiMarkets) {
    let bestMatch = null;
    let bestScore = 0;
    
    for (const pm of predictMarkets) {
      const titleScore = calculateSimilarity(km.title, pm.title || pm.question);
      // Boost score if expiry dates are close
      const kmExpiry = new Date(km.expiration_time);
      const pmExpiry = pm.endDate ? new Date(pm.endDate) : null;
      const dateBoost = pmExpiry && Math.abs(kmExpiry - pmExpiry) < 7 * 86400000 ? 0.15 : 0;
      
      const score = titleScore + dateBoost;
      if (score > bestScore && score >= threshold) {
        bestScore = score;
        bestMatch = pm;
      }
    }
    
    if (bestMatch) {
      matched.push({
        kalshi: km,
        predict: bestMatch,
        matchScore: bestScore,
      });
    }
  }
  
  return matched;
}
```

#### 3.1.3 Normalizar datos al formato unificado de ProphetLabs

```javascript
function normalizeKalshiMarket(km) {
  return {
    platformKey: "kalshi",
    externalId: km.ticker,
    title: km.title,
    category: km.category || "Other",
    yes: parseFloat(km.yes_bid_dollars) || km.yes_bid / 100,
    no: parseFloat(km.no_bid_dollars) || km.no_bid / 100,
    yesBid: parseFloat(km.yes_bid_dollars),
    yesAsk: parseFloat(km.yes_ask_dollars),
    volume24h: parseInt(km.volume_24h_fp || km.volume_24h) || 0,
    expiry: km.expiration_time,
    openInterest: km.open_interest || 0,
    status: km.status,
  };
}

function normalizePredictMarket(pm) {
  // Predict uses different field names — adapt based on actual API response
  return {
    platformKey: "predict",
    externalId: String(pm.id || pm.marketId),
    title: pm.title || pm.question,
    category: pm.category?.name || "Other",
    yes: pm.lastPrice || pm.bestBid || 0.5,
    no: 1 - (pm.lastPrice || pm.bestBid || 0.5),
    yesBid: pm.bestBid || null,
    yesAsk: pm.bestAsk || null,
    volume24h: pm.volume24h || 0,
    expiry: pm.endDate || pm.expirationDate,
    status: pm.status || "active",
  };
}
```

---

### FASE 2: Integración en el Estado del Dashboard

#### 3.2.1 Nuevo state management en `Dash` component

Reemplazar la inicialización mock del state `prices` (línea ~1300) con un data-fetching real:

```javascript
// Estado para API keys y modo
const [apiKeys, setApiKeys] = useState({ predict: "" });
const [dataMode, setDataMode] = useState("mock"); // "mock" | "live"
const [loading, setLoading] = useState(false);
const [apiError, setApiError] = useState(null);
const [rawKalshi, setRawKalshi] = useState([]);
const [rawPredict, setRawPredict] = useState([]);

// Fetch real data
const fetchLiveData = useCallback(async () => {
  setLoading(true);
  setApiError(null);
  
  try {
    // Kalshi: no auth needed for public data
    const kalshiData = await fetchKalshiMarkets({ status: "open", limit: 200 });
    setRawKalshi(kalshiData.markets || []);
    
    // Predict: needs API key
    let predictData = { data: [] };
    if (apiKeys.predict) {
      predictData = await fetchPredictMarkets(apiKeys.predict);
    }
    setRawPredict(predictData.data || []);
    
    // Match and merge
    const kalshiNorm = kalshiData.markets.map(normalizeKalshiMarket);
    const predictNorm = (predictData.data || []).map(normalizePredictMarket);
    
    // Build unified market list
    const unified = buildUnifiedMarkets(kalshiNorm, predictNorm);
    setPrices(unified);
    
  } catch (err) {
    setApiError(err.message);
    console.error("API fetch error:", err);
  } finally {
    setLoading(false);
  }
}, [apiKeys]);
```

#### 3.2.2 Función `buildUnifiedMarkets`

Transforma datos normalizados al formato que ya espera la UI:

```javascript
function buildUnifiedMarkets(kalshiMarkets, predictMarkets) {
  // Match cross-platform
  const matched = matchMarkets(
    kalshiMarkets.map(m => ({ ...m, title: m.title })),
    predictMarkets.map(m => ({ ...m, title: m.title }))
  );
  
  // Para mercados sin match, crear entrada solo con la plataforma disponible
  const usedKalshi = new Set(matched.map(m => m.kalshi.externalId));
  const usedPredict = new Set(matched.map(m => m.predict.externalId));
  
  const unified = [];
  let idCounter = 1;
  
  // Matched pairs (arbitrage candidates!)
  for (const { kalshi: km, predict: pm, matchScore } of matched) {
    unified.push({
      id: idCounter++,
      event: km.title,
      names: {
        kalshi: km.title,
        predict: pm.title,
        polymarket: km.title,  // placeholder
        opinion: km.title,     // placeholder
      },
      category: km.category,
      allPrices: {
        kalshi: { yes: km.yes, no: km.no },
        predict: { yes: pm.yes, no: pm.no },
        polymarket: { yes: km.yes, no: km.no }, // default to kalshi
        opinion: { yes: pm.yes, no: pm.no },    // default to predict
      },
      prices: {
        kalshi: { yes: km.yes, no: km.no },
        predict: { yes: pm.yes, no: pm.no },
        polymarket: { yes: km.yes, no: km.no },
        opinion: { yes: pm.yes, no: pm.no },
      },
      spread: Math.abs(km.yes - pm.yes),
      volume: km.volume24h + pm.volume24h,
      expiry: km.expiry,
      status: matchScore > 0.6 ? "hot" : "active",
      liquidity: Math.min(100, Math.round((km.openInterest || 0) / 1000)),
      bookDepth: km.openInterest || 50000,
      matchScore,
      // Compute APR
      apr: (() => {
        const cb = km.yes * 1.01 + (1 - pm.yes) * 1.015;
        const np = 1 - cb;
        const dte = Math.max(1, (new Date(km.expiry) - new Date()) / 86400000);
        return cb > 0 ? (np / cb) * (365 / dte) * 100 : 0;
      })(),
      // Source references for deep linking
      _sources: { kalshi: km.externalId, predict: pm.externalId },
    });
  }
  
  // Unmatched kalshi markets (still useful for display)
  for (const km of kalshiMarkets) {
    if (!usedKalshi.has(km.externalId)) {
      unified.push({
        id: idCounter++,
        event: km.title,
        names: { kalshi: km.title, predict: "—", polymarket: km.title, opinion: "—" },
        category: km.category,
        allPrices: {
          kalshi: { yes: km.yes, no: km.no },
          predict: { yes: 0.5, no: 0.5 },
          polymarket: { yes: km.yes, no: km.no },
          opinion: { yes: 0.5, no: 0.5 },
        },
        prices: {
          kalshi: { yes: km.yes, no: km.no },
          predict: { yes: 0.5, no: 0.5 },
          polymarket: { yes: km.yes, no: km.no },
          opinion: { yes: 0.5, no: 0.5 },
        },
        spread: 0,
        volume: km.volume24h,
        expiry: km.expiry,
        status: "active",
        liquidity: Math.min(100, Math.round((km.openInterest || 0) / 1000)),
        bookDepth: km.openInterest || 50000,
        matchScore: 0,
        apr: 0,
        _sources: { kalshi: km.externalId },
      });
    }
  }
  
  return unified;
}
```

---

### FASE 3: Cambios en la UI

#### 3.3.1 API Settings Panel (nuevo componente)

Añadir un panel de configuración de API keys en el dashboard:

```javascript
const ApiSettingsPanel = ({ apiKeys, setApiKeys, dataMode, setDataMode, onRefresh }) => {
  // Componente con:
  // - Toggle mock/live mode
  // - Input para Predict API key (Kalshi no necesita)
  // - Botón "Test Connection"
  // - Status indicators por plataforma
  // - Persistir keys en window.storage (encriptadas si es posible)
};
```

**Ubicación en la UI**: Nuevo botón en la navbar del dashboard (junto al toggle de effects), abre un panel lateral o modal.

#### 3.3.2 Actualizar el Market Pair Selector (líneas 1610-1700)

El selector ya soporta las 4 plataformas. Los cambios necesarios:

1. **Indicador de conexión**: Añadir un dot verde/rojo junto a cada plataforma en el dropdown indicando si hay datos reales
2. **Tooltips**: Mostrar "Live data" vs "Mock data" según la plataforma
3. **Auto-pair**: Cuando se selecciona Kalshi vs Predict, mostrar solo mercados con match real

#### 3.3.3 Market Row Updates

En la tabla principal (líneas 1900+), añadir:

1. **Badge "LIVE"**: Indicador en cada fila de si los datos son reales
2. **Deep link**: Click en el nombre del mercado abre la URL de la plataforma
3. **Match confidence**: Badge de "Match: 85%" cuando hay cross-platform match
4. **Last trade time**: Timestamp del último trade real

#### 3.3.4 Actualizar fees reales

```javascript
// Línea 6-9: Actualizar PLATFORMS con fees reales
const PLATFORMS = {
  kalshi: { 
    ..., 
    fee: 0.01,  // Kalshi: ~1% taker fee (verificar docs actualizados)
    settlement: "CFTC-regulated exchange (USD)", 
    trust: 88 
  },
  predict: { 
    ..., 
    fee: 0.015, // Predict: fee_rate_bps del mercado / 10000
    settlement: "BNB Chain (USDT)", 
    trust: 74 
  },
};
```

---

### FASE 4: Polling en Tiempo Real

#### 3.4.1 Reemplazar el mock interval (líneas 1444-1498)

El intervalo actual simula cambios random cada 30s. Reemplazar con:

```javascript
useEffect(() => {
  if (dataMode !== "live") {
    // Keep existing mock logic for demo mode
    // ... existing interval code ...
    return;
  }
  
  // Live mode: poll APIs
  const pollInterval = setInterval(async () => {
    try {
      await fetchLiveData();
      setLastUpdate(new Date());
      countdownRef.current = 30;
      setCountdown(30);
      setRingFlash(true);
      setTimeout(() => setRingFlash(false), 400);
    } catch (err) {
      console.error("Poll error:", err);
    }
  }, 30000); // 30s interval
  
  // Initial fetch
  fetchLiveData();
  
  return () => clearInterval(pollInterval);
}, [dataMode, fetchLiveData]);
```

#### 3.4.2 WebSocket (Fase avanzada)

Para latencia ultra-baja, implementar WebSocket connections:

```javascript
// Kalshi WebSocket
const kalshiWs = new WebSocket("wss://api.elections.kalshi.com/trade-api/v2/ws");
// Subscribe to ticker channel for real-time price updates

// Predict WebSocket
const predictWs = new WebSocket("wss://ws.predict.fun/ws?apiKey=" + apiKeys.predict);
// Handle heartbeat every 15s (OBLIGATORIO)
// Subscribe to market price topics
```

---

### FASE 5: Order Book Real

#### 3.5.1 Adaptar el DepthChart component (líneas ~560-700)

Actualmente usa `genBook()` (datos fake). Reemplazar con:

```javascript
// Fetch real orderbooks when a market row is expanded
const fetchRealOrderbooks = async (market) => {
  const books = {};
  
  if (market._sources?.kalshi) {
    const kb = await fetchKalshiOrderbook(market._sources.kalshi);
    // Kalshi solo retorna bids — derivar asks
    books.kalshi = {
      bids: kb.orderbook?.yes || [],
      asks: kb.orderbook?.no?.map(([p, q]) => [1 - p / 100, q]) || [],
    };
  }
  
  if (market._sources?.predict && apiKeys.predict) {
    const pb = await fetchPredictOrderbook(apiKeys.predict, market._sources.predict);
    books.predict = {
      bids: pb.data?.bids || [],
      asks: pb.data?.asks || [],
    };
  }
  
  return books;
};
```

---

## 4. CONSIDERACIONES TÉCNICAS

### 4.1 CORS y Proxy

**PROBLEMA CRÍTICO**: Las APIs de Kalshi y Predict probablemente bloquean requests desde el navegador (CORS).

**Soluciones**:
1. **Proxy backend**: Crear un simple proxy en Node.js/Express que forwarde las requests
2. **Cloudflare Worker**: Proxy serverless que añade headers CORS
3. **En el artifact de Claude.ai**: Usar la API de Anthropic con web_search como intermediario NO es viable para datos en tiempo real

**Recomendación para MVP**: Backend proxy con Express:
```javascript
// proxy-server.js
app.get("/api/kalshi/*", async (req, res) => {
  const path = req.path.replace("/api/kalshi", "");
  const response = await fetch(`https://api.elections.kalshi.com/trade-api/v2${path}`);
  res.json(await response.json());
});

app.get("/api/predict/*", async (req, res) => {
  const path = req.path.replace("/api/predict", "");
  const response = await fetch(`https://api.predict.fun${path}`, {
    headers: { "x-api-key": req.headers["x-predict-key"] }
  });
  res.json(await response.json());
});
```

### 4.2 Rate Limiting

| Plataforma | Límite | Estrategia |
|-----------|--------|-----------|
| Kalshi | No documentado claramente; usar cache conservador | Cache 15-30s, batch requests |
| Predict | 240 req/min | Max 4 req/s, queue requests |

### 4.3 Manejo de Errores

```javascript
// Wrapper con retry y fallback a mock
async function fetchWithFallback(fetchFn, mockData, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchFn();
    } catch (err) {
      if (i === retries) {
        console.warn("API failed, falling back to mock:", err);
        return mockData;
      }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
```

### 4.4 Persistencia de Configuración

Usar el sistema `window.storage` ya existente:

```javascript
// Guardar API keys
window.storage.set("pl_api_keys", JSON.stringify({ predict: "..." }));

// Guardar preferencia de modo
window.storage.set("pl_data_mode", "live"); // or "mock"
```

---

## 5. NUEVO DISEÑO DEL FRONTEND

### 5.1 Cambios en la Navbar

```
[Logo] [SCANNER] | [🔴 Kalshi] [🟢 Predict] | [LIVE ●] [⚙ API] [✦ FX] [PAIR/MATRIX] [Timer]
```

- Indicadores de estado por plataforma
- Botón ⚙ para abrir API settings

### 5.2 API Settings Modal

Diseño glassmorphism consistente con el tema actual:
- Toggle: MOCK / LIVE mode
- Input: Predict API Key (con botón eye/hide)
- Input: Kalshi API Key (opcional, solo para trading)
- Status cards por plataforma: ✓ Connected / ✗ No key / ⚠ Error
- Botón: Test All Connections
- Info: Rate limit status, last successful fetch

### 5.3 Match Confidence Badge

En cada fila de la tabla, si el mercado tiene match cross-platform:
```
[BTC $150K by Dec] ━━ Match: 87% ━━ [Kalshi ◆ 38¢] vs [Predict ▲ 44¢]
```

### 5.4 Platform Connection Status Bar

Barra justo debajo de la navbar:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ◆ Kalshi: 847 markets · 12ms    ▲ Predict: 234 markets · 45ms    Mode: LIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 6. ORDEN DE EJECUCIÓN (PARA SONNET)

### Sprint 1: API Layer (sin cambios en UI)
1. ☐ Añadir `ApiService` funciones al inicio del archivo (después de MOCK)
2. ☐ Añadir `normalizeKalshiMarket` y `normalizePredictMarket`
3. ☐ Añadir `matchMarkets` y `buildUnifiedMarkets`
4. ☐ Añadir `fetchWithFallback` wrapper

### Sprint 2: State Integration
5. ☐ Añadir states para `apiKeys`, `dataMode`, `loading`, `apiError` en `Dash`
6. ☐ Añadir `fetchLiveData` callback en `Dash`
7. ☐ Modificar `useEffect` de polling para soportar mock/live toggle
8. ☐ Persistir API keys con `window.storage`

### Sprint 3: UI — Settings
9. ☐ Crear `ApiSettingsPanel` componente
10. ☐ Añadir botón settings en navbar
11. ☐ Modal/panel con inputs de API keys y toggle mock/live
12. ☐ Connection status indicators

### Sprint 4: UI — Market Table
13. ☐ Añadir badge "LIVE" / "MOCK" en cada fila
14. ☐ Añadir match confidence indicator
15. ☐ Deep links a plataformas originales
16. ☐ Actualizar Platform Connection Status Bar

### Sprint 5: Order Book Real
17. ☐ `fetchRealOrderbooks` función
18. ☐ Adaptar `DepthChart` para datos reales
19. ☐ Fallback a genBook() cuando no hay datos

### Sprint 6: WebSocket (Avanzado)
20. ☐ Kalshi WebSocket connection
21. ☐ Predict WebSocket connection con heartbeat handler
22. ☐ Real-time price updates sin polling

---

## 7. ARCHIVOS MODIFICADOS

| Archivo | Cambios |
|---------|---------|
| `prophetlabs_23_B_W_ORANGE_BLUE_AURORA_REV22.jsx` | TODO — es single-file |

### Secciones del archivo a modificar:

| Líneas | Sección | Cambio |
|--------|---------|--------|
| 1-10 | PLATFORMS | Actualizar fees reales |
| 12-24 | MOCK | Mantener como fallback, añadir flag `_isMock` |
| Post-42 | **NUEVO** | API Services, Matcher, Normalizers |
| 1295-1400 | Dash state | Añadir api states, fetchLiveData |
| 1439-1498 | Polling interval | Bifurcar mock/live |
| 1500-1510 | Platform helpers | Actualizar para datos reales |
| 1560-1600 | Navbar | Añadir API settings button + status |
| Post-1600 | **NUEVO** | ApiSettingsPanel, ConnectionBar |
| 1900+ | Table rows | Badges, deep links, match confidence |

---

## 8. NOTAS FINALES

- **Mantener retrocompatibilidad**: El modo MOCK debe seguir funcionando perfectamente
- **No romper la UI existente**: Todos los cambios son aditivos
- **El glassmorphism/aurora theme se mantiene**: Nuevos componentes deben seguir el design system existente (tokens `T`, estilos `S`)
- **Keyboard shortcuts**: Añadir `l` para toggle mock/live, `s` para settings
- **Las APIs de Kalshi son públicas** para market data — priorizar esta integración primero
- **Predict requiere API key** — implementar graceful degradation si no hay key
