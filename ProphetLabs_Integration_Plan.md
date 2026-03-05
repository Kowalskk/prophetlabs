# ProphetLabs — Plan de Integración Backend + Frontend

## Resumen Ejecutivo

Tenemos dos partes avanzadas que necesitan conectarse. Este documento cubre el estado de cada una, los puntos de integración, y el plan de acción.

---

## PARTE 1: Backend (Saulo) — Estado Actual

### ¿Qué hace?
Motor de detección de arbitraje entre **Polymarket** y **Opinion Labs** en tiempo real. Funciona como un proceso Python que corre 24/7, escanea ambas plataformas, identifica pares de mercados equivalentes, y alerta oportunidades de arbitraje vía Telegram.

### Arquitectura
```
┌─────────────────────────────────────────────────┐
│              ProphetLabs v15.1                    │
│                                                   │
│  ┌──────────┐    ┌──────────┐    ┌───────────┐  │
│  │Polymarket │    │ Opinion  │    │  LLM API  │  │
│  │ REST+WS   │    │  REST    │    │ (Gemini)  │  │
│  └────┬──────┘    └────┬─────┘    └─────┬─────┘  │
│       │               │                │         │
│       ▼               ▼                ▼         │
│  ┌─────────────────────────────────────────────┐ │
│  │        MATCHING ENGINE (3-pass)              │ │
│  │  Pass 1: Subject-based (compatible())       │ │
│  │  Pass 2: Entity extraction (team/person)    │ │
│  │  Pass 3: Text similarity (word overlap)     │ │
│  └──────────────────┬──────────────────────────┘ │
│                     │                             │
│                     ▼                             │
│  ┌─────────────────────────────────────────────┐ │
│  │        VALIDATION (2-tier)                   │ │
│  │  Tier 1: Rule-based (deterministic)         │ │
│  │  Tier 2: LLM (ambiguous cases)              │ │
│  └──────────────────┬──────────────────────────┘ │
│                     │                             │
│                     ▼                             │
│  ┌─────────────────────────────────────────────┐ │
│  │        ARBITRAGE DETECTION                   │ │
│  │  Spreads, APR, profit calculations          │ │
│  └──────────────────┬──────────────────────────┘ │
│                     │                             │
│                     ▼                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Telegram │  │ pairs.json│  │ Console  │       │
│  │  Alerts  │  │ (state)  │  │  Display │       │
│  └──────────┘  └──────────┘  └──────────┘       │
└─────────────────────────────────────────────────┘
```

### Stack Técnico
- **Lenguaje**: Python 3.14 (asyncio)
- **APIs**: Polymarket Gamma API + CLOB WebSocket, Opinion Labs REST API
- **LLM**: Google Gemini 2.5 Flash Lite via OpenRouter (gratis)
- **Validación**: Rule-based (entity extraction) + LLM (batch validation)
- **State**: JSON file (pairs.json) con pares aprobados/rechazados/pendientes
- **Alertas**: Telegram Bot API (polling manual)
- **Dependencias**: aiohttp, websockets, python-telegram-bot

### Datos que el Backend genera por cada par
```json
{
  "pair": {
    "poly_market": {
      "id": "will-apple-release-foldable-iphone-2026",
      "question": "Apple releases foldable iPhone",
      "slug": "will-apple-release-foldable-iphone-2026",
      "exchange": "polymarket",
      "outcomes": ["Yes", "No"],
      "yes_price": 0.142,
      "no_price": 0.849,
      "volume": 890000
    },
    "op_market": {
      "id": "12345",
      "question": "Foldable iPhone announced by Apple",
      "exchange": "opinion",
      "outcomes": ["Yes", "No"],
      "yes_price": 0.213,
      "no_price": 0.793,
      "volume": 504000
    },
    "similarity": 0.86,
    "status": "approved",
    "spread": 7.1,
    "apr": 8.6,
    "directions": {
      "buy_poly_yes_op_no": { "cost": 0.935, "profit_pct": 6.5 },
      "buy_poly_no_op_yes": { "cost": 1.062, "profit_pct": -6.2 }
    }
  }
}
```

### Capacidades actuales
- ✅ Fetch 500 mercados Polymarket + 400 Opinion Labs (binary + categorical)
- ✅ Matching 3-pass (subject → entity → text similarity)
- ✅ Validación rule-based para deportes/categorical (auto-approve/reject sin LLM)
- ✅ Validación LLM para pares ambiguos (Gemini 2.5 Flash Lite)
- ✅ WebSocket Polymarket para precios real-time
- ✅ Detección de arbitraje con cálculo de spread, APR, profit
- ✅ Alertas profesionales vía Telegram (dashboard HTML)
- ✅ Base de datos de pares con persistencia (pairs.json)
- ✅ Pattern learning para rechazos recurrentes

### Capacidades que FALTAN (necesarias para el frontend)
- ❌ **API REST/WebSocket propia** — actualmente todo se consume internamente, no hay endpoint HTTP para que el frontend consulte
- ❌ **Categorización de mercados** — el frontend muestra categorías (Crypto, Economy, Politics, Tech) pero el backend no clasifica
- ❌ **Cálculo de fees** — Polymarket 2.17% fee, Opinion Labs 0% — necesario para el profit calculator
- ❌ **Order book data** — el frontend tiene vista de order book pero el backend no lo expone
- ❌ **Historial de precios** — para las mini-charts del frontend
- ❌ **Liquidez/slippage** — el frontend muestra LIQ score, necesita datos de order book depth
- ❌ **Market expiry dates** — necesario para calcular APR correcto
- ❌ **Volumen 24h de ambas plataformas** — para filtros del frontend
- ❌ **Favoritos/watchlist** — persistencia de usuario

---

## PARTE 2: Frontend (Socio) — Lo que veo en el video

### Tecnología
- **Framework**: React (JSX artifact en Claude)
- **Versión**: "Prophetlabs 22 b w orange blue aurora"
- **Estado**: Prototype/mockup funcional con datos MOCK

### Features observadas en el video

**1. Scanner Principal (vista tabla)**
- Header: logo ProphetLabs + "SCANNER" + indicador LIVE + reloj + countdown timer (26s)
- Banner "TOP BEST SIGNAL" con mercado destacado (mayor spread)
- Barra de búsqueda
- Filtros por categoría: ALL, TRADE, CRYPTO, ECONOMY, POLITICS, TECH
- Toggle "PROFITABLE ONLY" (filtra mercados con ARR > 0)
- Contador: "Showing 4 of 10 markets"
- Panel de Filters expandible:
  - Market Expiry (days): slider 1-500 (default 500 days)
  - Min 24h Volume: slider $0-$5M (default $300K)
  - Active Liquidity: slider $0-$100K (default $1K)

**2. Trade Viability Calculator (por mercado)**
- Selector de mercado con precios Poly vs Opin
- Slider de Trade Size: $100 - $10K+
- Métricas calculadas:
  - Eff. Spread: 5.83%
  - Slippage: 1.26%
  - Live APR: 7.3%
  - Avg Price: 0.155
  - Max Profitable: $33.6K
  - Optimal APR: $18.1K

**3. Tabla de mercados (columnas)**
- MARKET (nombre + títulos de ambas plataformas)
- POLYMARKET (precio YES/NO con mini sparklines)
- OPINION LABS (precio YES/NO con mini sparklines)
- SPREAD (%) con indicador
- LIQ (liquidity score con barra visual)
- APR (%) annualized
- VOLUME ($)
- EXPIRY (fecha)
- ROI (%) 
- Estrella favoritos + expand arrow

**4. Vista detalle de mercado expandida**
- Tabs: TRADE | ORDER BOOK | RISK
- Strategy explanation: "Buy YES on Polymarket, NO on Opinion Labs"
- Wager Size con presets: $100, $500, $1K, $5K, $10K
- Cálculos por lado:
  - POLYMARKET SIDE: Avg Share Price, Shares to Buy, Total Cost, Est. Fee (2.17%), Total Cost inc fees, ROI, Payout if this side wins
  - OPINION LABS SIDE: Avg Share Price, Shares to Buy, Total Cost, Est. Fee ($0), Total Cost inc fees, Payout if this side wins
- GUARANTEED NET PNL: profit regardless of outcome
- COPY TRADE SUMMARY
- Botones: "GO TO POLYMARKET →" / "GO TO OPINION LABS →"

**5. Pricing Page**
- Starter ($19/mo): Poly + Opinion, 10min updates, 5 alerts/day
- Pro ($79/mo): 30s updates, unlimited alerts, APR & fee analytics, API access
- Whale ($249/mo): WebSocket live, auto-execution, copy trading, custom integrations

**6. Risk Tab (mencionado en changelog)**
- Platform Risk (trust/liquidity/settlement)
- Event Resolution Risk (category-specific)
- Concentration Warning (portfolio)

**7. Color scheme**
- Azul Polymarket (#4C8BF5)
- Naranja/Rojo Opinion (#E05555 negative, #D4A843 warning)
- Theme: dark mode con aurora effects

---

## PLAN DE INTEGRACIÓN

### Opción A: API REST (Recomendada para MVP)
El backend expone una API HTTP que el frontend consume.

```
Backend (Python)                    Frontend (React)
┌──────────────────┐               ┌──────────────────┐
│  ProphetLabs     │    REST API   │  React App       │
│  Engine          ├──────────────►│                  │
│                  │               │  Scanner         │
│  + FastAPI       │◄──────────────┤  Calculator      │
│    /api/markets  │   WebSocket   │  Trade View      │
│    /api/pairs    │               │  Filters         │
│    /ws/prices    │               │                  │
└──────────────────┘               └──────────────────┘
```

**Endpoints necesarios:**
```
GET  /api/pairs              → Lista de pares aprobados con precios
GET  /api/pairs/{id}         → Detalle de un par (order book, history)
GET  /api/stats              → Stats generales (total markets, active arbs)
WS   /ws/prices              → Stream de precios real-time
POST /api/pairs/{id}/approve → Aprobar par (admin)
POST /api/pairs/{id}/reject  → Rechazar par (admin)
```

**Esfuerzo**: ~2-3 días para añadir FastAPI al backend

### Opción B: JSON File Polling (Quick & Dirty)
El backend escribe un JSON con todos los datos, el frontend lo lee cada X segundos.

**Esfuerzo**: ~4 horas pero no escala y no es real-time

### Opción C: WebSocket Directo
El backend pushea actualizaciones al frontend via WebSocket.

**Esfuerzo**: ~3-4 días, más complejo pero más performante

### Recomendación: Empezar con Opción A + elementos de C
1. FastAPI para REST endpoints (datos estáticos: pares, categorías, stats)
2. WebSocket solo para precios live (ya tenemos WS de Polymarket)
3. Frontend consume REST para lista, WS para precios

---

## CAMPOS QUE EL FRONTEND NECESITA Y EL BACKEND DEBE PROVEER

| Campo Frontend | Campo Backend | Estado | Prioridad |
|---|---|---|---|
| Market name | pair.poly_market.question | ✅ Existe | — |
| Poly price YES/NO | pair.poly_market.yes_price | ✅ Existe | — |
| Opinion price YES/NO | pair.op_market.yes_price | ✅ Existe | — |
| Spread % | pair.spread | ✅ Existe | — |
| APR % | Calcular desde spread + expiry | ⚠️ Parcial | Alta |
| Volume | pair.volume | ⚠️ Solo Poly | Alta |
| Expiry date | No extraído | ❌ Falta | Alta |
| Liquidity score | Order book depth | ❌ Falta | Media |
| Category | Clasificación del mercado | ❌ Falta | Media |
| Fee calculation | Poly 2.17%, Opin 0% | ❌ Falta | Alta |
| Slippage estimate | Order book depth | ❌ Falta | Media |
| Price history | Time series | ❌ Falta | Baja |
| ROI calculation | Profit / cost | ⚠️ Parcial | Alta |
| Max profitable | Max size sin mover mercado | ❌ Falta | Baja |

---

## PASOS INMEDIATOS PARA LA REUNIÓN

### 1. Lo que el socio debe pedir a su Claude
Dile que escriba exactamente esto en su chat de Claude:

> **"Necesito que generes un documento técnico de especificación de la interfaz ProphetLabs que estamos construyendo. Incluye:**
> 
> **1. Estructura de datos completa que el frontend espera recibir (TypeScript interfaces) — qué campos necesita cada componente (Scanner table, Trade Calculator, Order Book, Risk tab, Filters)**
> 
> **2. Lista de todos los endpoints API que el frontend necesitaría consumir (REST + WebSocket)**
> 
> **3. Formato exacto de los datos MOCK actuales — el JSON/objeto que usas para alimentar la UI**
> 
> **4. Lista de filtros y opciones del usuario que necesitan datos del backend (categorías, volume thresholds, expiry ranges, liquidity scores)**
> 
> **5. Eventos WebSocket que el frontend espera recibir (price updates, new arbitrage, alert triggers)**
> 
> **6. Stack técnico usado (React version, state management, styling, deployment target)**
> 
> **El objetivo es compartir esto con el equipo de backend para definir la API de integración."**

### 2. Lo que nosotros preparamos para él
Este mismo documento que estás leyendo, más el código del backend.

### 3. Decisión clave en la reunión
**¿Empezar integración ahora o seguir puliendo?**

**Mi recomendación: INTEGRAR AHORA, pulir después.** Razón:
- El backend funciona (detecta pares, calcula spreads)
- El frontend funciona (UI completa con datos mock)
- El punto de integración (API) es el eslabón más débil y más importante de validar
- Pulir cada parte por separado sin saber cómo se conectan = riesgo de retrabajo
- Con la integración hecha, pueden pulir JUNTOS viendo datos reales en la UI

**Plan de 1 semana:**
- Día 1-2: Añadir FastAPI al backend con endpoints básicos
- Día 3: Frontend reemplaza MOCK data con llamadas al API
- Día 4-5: Ajustar campos, añadir categorización, fees, expiry dates
- Día 6-7: WebSocket para precios live, testing end-to-end

---

## SOBRE BACKTESTING

**No es el momento.** Backtesting requiere datos históricos que no tenemos (necesitaríamos guardar snapshots de precios durante semanas). Lo que sí podemos hacer ahora:
- **Paper trading**: Correr el sistema en modo live sin ejecutar trades, registrar las oportunidades que detecta, y después verificar manualmente si habrían sido rentables.
- **Logging de oportunidades**: Guardar cada alerta con timestamp + precios → esto genera datos para backtesting futuro.
- **Validación manual**: Revisar los 23 pares auto-aprobados y confirmar que son correctos.

---

*Documento generado el 27 Feb 2026 — ProphetLabs v15.1*
