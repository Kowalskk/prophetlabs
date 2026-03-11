<div align="center">

# ⚡ ProphetLabs

**Cross-platform prediction market arbitrage engine**

Detects pricing discrepancies between Polymarket and Opinion Labs in real time.
WebSocket streaming, three-pass matching engine, LLM-validated market pairing.

![Status](https://img.shields.io/badge/Status-Live-brightgreen?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker&logoColor=white)

</div>

---

## Why this exists

Prediction markets are fragmented. The same event gets priced differently across platforms.
I was checking spreads manually between Polymarket and Opinion Labs. Got tired of it. Built this.

---

## How it works

```
Polymarket ──WebSocket──▶ ┌──────────────────────┐ ──▶ React Dashboard
                          │  3-Pass Matching      │
                          │  1. Fuzzy text match   │
                          │  2. Semantic similarity │ ──▶ Telegram Bot
                          │  3. LLM validation     │     (remote control)
Opinion Labs ─WebSocket─▶ └──────────────────────┘
```

1. Streams prices from both platforms via WebSocket
2. Matches equivalent markets across platforms (this is the hard part)
3. Detects mathematical arbitrage: YES + NO spread capture
4. Alerts via Telegram with full remote control

---

## Tech stack

| Layer | What | Why |
|-------|------|-----|
| Backend | Python 3.11+, FastAPI, asyncio | Fast, async-native, good for streaming |
| Frontend | React 18 (built with partner) | Real-time dashboard for monitoring |
| Matching | Three-pass engine + Gemini 2.5 Flash Lite | Fuzzy → semantic → LLM for edge cases |
| Alerts | Telegram Bot API | Mobile-first, I control everything from my phone |
| Deploy | Docker, docker-compose | One command to run everything |

---

## Run it

```bash
git clone https://github.com/Kowalskk/prophetlabs.git
cd prophetlabs
cp .env.example .env    # add your API keys
pip install -r requirements.txt
python src/main.py
```

Or with Docker:
```bash
docker-compose up -d
```

---

## What I learned building this

- **Market matching is harder than arbitrage detection.** Same event, different wording, different market structures. The 3-pass matching engine went through 15 major iterations (v15.1).
- **LLM validation is worth the latency.** Gemini Flash Lite resolves ambiguous pairs that fuzzy matching can't handle. The accuracy jump was worth the extra 200ms.
- **Telegram-first was the right call.** I manage this from my phone while doing other things. Building a web dashboard alone would have been a mistake.

---

## Screenshots

> Add screenshots in `/docs/screenshots/` once you have them.

---

## License

MIT
