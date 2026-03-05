# PROMPT MAESTRO — ProphetLabs Integration

Pégale esto al nuevo Claude junto con los 3 archivos adjuntos.

---

## PROMPT (copiar desde aquí):

Soy Saulo. Estoy construyendo **ProphetLabs**, una plataforma de arbitraje entre mercados de predicción (Polymarket vs Opinion Labs). Tengo dos partes del proyecto que necesito integrar:

### ARCHIVOS ADJUNTOS:
1. **prophetlabs_backend_v15.1.py** — Backend completo (Python, 2130 líneas)
2. **prophetlabs_frontend_rev10.jsx** — Frontend completo (React JSX, 2200 líneas, hecho por mi socio)
3. **ProphetLabs_Integration_Plan.md** — Documento de integración con arquitectura y plan

### QUÉ HACE EL BACKEND (mi parte):
- Motor de detección de arbitraje Python asyncio que corre 24/7
- Escanea 500 mercados Polymarket (REST + WebSocket) y 400 Opinion Labs (REST)
- Matching en 3 pasadas: subject-based → entity extraction → text similarity
- Validación en 2 tiers: rule-based (determinístico para deportes) + LLM (Gemini 2.5 Flash Lite via OpenRouter para ambiguos)
- Detecta spreads, calcula profit, alerta vía Telegram
- Estado en pairs.json (pares aprobados/rechazados/pendientes)
- **NO tiene API HTTP** — todo es consumo interno

### QUÉ HACE EL FRONTEND (parte de mi socio):
- React JSX con datos MOCK hardcodeados
- Dashboard scanner con tabla de mercados, precios de ambas plataformas, spread, APR, volume, liquidity
- Trade Viability Calculator (calcula ROI con fees Poly 2.17%, slippage)
- Filtros: categoría (Crypto/Politics/Economy/Tech), expiry, volume, liquidity
- Vista detalle: trade calculator, order book, risk tab
- Toggle "Profitable Only"
- Mini sparkline charts de precios
- Pricing tiers ($19/$79/$249)
- Theme: dark mode B&W con aurora effects

### ESTRUCTURA DE DATOS MOCK DEL FRONTEND:
```javascript
{
  id: 1,
  event: "Bitcoin above $150K by Dec 2026",      // Título unificado
  polyName: "BTC price ≥ $150,000 on Dec 31",    // Título Polymarket
  opinName: "Bitcoin hits $150K before 2027",     // Título Opinion Labs
  category: "Crypto",                             // Clasificación
  polymarket: { yes: 0.38, no: 0.62 },          // Precios Poly
  opinion: { yes: 0.42, no: 0.58 },             // Precios Opinion
  spread: 0.0526,                                // Spread decimal
  apr: 52.3,                                     // APR annualizado
  volume: 2400000,                               // Volumen USD
  expiry: "2026-12-31",                          // Fecha expiración
  status: "hot" | "active",                      // Estado
  liquidity: 87,                                 // Score 0-100
  bookDepth: 180000                              // Profundidad order book USD
}
```

### QUÉ NECESITO AHORA:
El plan es integrar ambas partes. La prioridad es:

1. **Añadir FastAPI al backend** — Exponer los datos como API REST + WebSocket:
   - `GET /api/pairs` → Lista de pares aprobados con precios live
   - `GET /api/pairs/{id}` → Detalle de un par
   - `GET /api/stats` → Stats generales
   - `WS /ws/prices` → Stream de precios real-time

2. **Adaptar el backend para generar los campos que el frontend necesita**:
   - `category` — Clasificar mercados (Crypto/Politics/Economy/Tech)
   - `expiry` — Extraer fecha de expiración del título
   - `liquidity` — Score basado en volumen
   - `apr` — Calcular APR anualizado desde spread + days to expiry
   - `bookDepth` — Estimación de profundidad

3. **Modificar el frontend** — Reemplazar MOCK data con llamadas al API real

### CONTEXTO TÉCNICO IMPORTANTE:
- El backend usa Python 3.14 en Windows
- `python-telegram-bot` tiene un bug con Python 3.14 (Updater broken) — ya lo resolvimos con polling manual via `Bot.get_updates()`
- WebSocket de Polymarket conecta pero `websockets 12.0` (legacy) no recibe datos correctamente
- El LLM validator usa OpenRouter API key: `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`
- El frontend es un Claude artifact JSX (React), no un proyecto npm standalone

### ESTILO DE TRABAJO:
- Hablo español
- Quiero código completo, listo para copiar y ejecutar
- Prefiero archivos completos en lugar de diffs parciales
- Uso Telegram como interfaz de control remoto
- El bot corre en mi Windows local

Empieza leyendo los 3 archivos y dame un plan de implementación paso a paso para la integración. Empezamos por el backend (FastAPI).
