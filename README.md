<div align="center">

# ⚡ ProphetLabs

**Cross-platform prediction market arbitrage engine**

Detects pricing discrepancies between Polymarket, Opinion Labs, Kalshi and Predict in real time.
WebSocket streaming, three-pass matching engine, LLM-validated market pairing.

![Status](https://img.shields.io/badge/Status-Live-brightgreen?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)

</div>

---

## Why this exists

Prediction markets are fragmented. The same event gets priced differently across platforms.
I was checking spreads manually between Polymarket and Opinion Labs. Got tired of it. Built this.
Then Kalshi and Predict got added to the radar too.

---

## How it works

```
Polymarket ──WebSocket──▶ ┌──────────────────────┐ ──▶ React Dashboard
Opinion Labs ────REST───▶ │  3-Pass Matching      │
                          │  1. Fuzzy text match   │
Kalshi ──RSA-signed────▶  │  2. Semantic similarity │ ──▶ Telegram Bot
Predict ──API-key──────▶  │  3. LLM validation     │     (remote control)
                          └──────────────────────┘
```

1. Streams prices from four platforms (Polymarket via WebSocket; the rest via authenticated REST proxied through the backend)
2. Matches equivalent markets across platforms (this is the hard part)
3. Detects mathematical arbitrage: YES + NO spread capture, with ROI and annualized APR
4. Alerts via Telegram with full remote control

---

## Architecture

Two Python processes plus a React frontend:

| Component | File | Role |
|-----------|------|------|
| Scanner | `src/core/prophetlabs_backend.py` | Streams prices, matches markets, finds arbitrage, drives the Telegram bot. Writes state to `pairs.json`. |
| API | `src/api/routes.py` | FastAPI REST + WebSocket layer. Reads `pairs.json`, fetches live prices, signs Kalshi (RSA) and Predict requests, serves the dashboard. |
| Frontend | `src/main.jsx` + Vite | Real-time dashboard: filters, trade calculator, order book depth. |

---

## Tech stack

| Layer | What | Why |
|-------|------|-----|
| Backend | Python 3.11+, FastAPI, asyncio | Fast, async-native, good for streaming |
| Frontend | React 18 + Vite (built with partner) | Real-time dashboard for monitoring |
| Matching | Three-pass engine + Gemini 2.5 Flash Lite | Fuzzy → semantic → LLM for edge cases |
| Alerts | Telegram Bot API | Mobile-first, I control everything from my phone |

---

## Run it

```bash
git clone https://github.com/Kowalskk/prophetlabs.git
cd prophetlabs
cp .env.example .env    # add your API keys
pip install -r requirements.txt
pip install python-telegram-bot websockets   # scanner extras

# Terminal 1 — scanner + Telegram bot
python src/core/prophetlabs_backend.py

# Terminal 2 — REST/WebSocket API (http://localhost:8000/api/pairs)
python src/api/routes.py

# Terminal 3 — dashboard
npm install && npm run dev
```

Tests:
```bash
python -m pytest tests/
```

---

## What I learned building this

- **Market matching is harder than arbitrage detection.** Same event, different wording, different market structures. The 3-pass matching engine went through 15 major iterations (v15.1).
- **LLM validation is worth the latency.** Gemini Flash Lite resolves ambiguous pairs that fuzzy matching can't handle. The accuracy jump was worth the extra 200ms.
- **Telegram-first was the right call.** I manage this from my phone while doing other things. Building a web dashboard alone would have been a mistake.
- **Some exchanges really don't want you there.** Kalshi v2 requires RSA PKCS1v15 request signing; the backend proxy handles it so the frontend never touches credentials.

---

## Screenshots

> Add screenshots in `/docs/screenshots/` once you have them.

---

## License

MIT
