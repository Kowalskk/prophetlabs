"""
╔══════════════════════════════════════════════════════════════════╗
║  ProphetLabs API v1.0 — FastAPI REST + WebSocket Layer            ║
║                                                                  ║
║  Corre como proceso SEPARADO junto a main.py.                    ║
║  Lee pairs.json y llama a las APIs en vivo para precios.         ║
║                                                                  ║
║  pip install fastapi uvicorn[standard] aiohttp                   ║
║  python prophetlabs_api.py                                       ║
║  → http://localhost:8000/api/pairs                               ║
╚══════════════════════════════════════════════════════════════════╝
"""

import asyncio
import json
import sys
import traceback
import os
import re
import time

# Windows consoles default to cp1252, which can't print the emoji in our logs
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import aiohttp
import uvicorn
import base64
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import serialization
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ════════════════════════════════════════════════════════════════
# CONFIG — mismos valores que main.py
# ════════════════════════════════════════════════════════════════
PAIRS_FILE   = "pairs.json"          # escrito por main.py
POLY_URL     = "https://gamma-api.polymarket.com/markets"
OP_BASE      = "https://proxy.opinion.trade:8443/openapi"
OP_KEY       = "QR7aUdjPvQ8PcyTKfTZKeeYkwTBLaiTp"
OP_HDR       = {"apikey": OP_KEY, "Accept": "application/json"}

POLY_PAGES   = 15
POLY_PP      = 100
POLY_FEE     = 0.0217   # 2.17%
OP_FEE       = 0.0      # 0%

# Cuánto tiempo (seg) cachear los precios antes de refrescar
PRICE_CACHE_TTL  = 30
# Intervalo de broadcast WebSocket (segundos)
WS_BROADCAST_INTERVAL = 5

# ════════════════════════════════════════════════════════════════
# AUTHENTICATION & KEYS
# ════════════════════════════════════════════════════════════════
KALSHI_API_KEY_ID = "84a9ad74-f4cc-4a7b-bb71-9013ac71751c"
KALSHI_PRIVATE_KEY_PEM = """-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEAx055vggsJHPnuzchyAn1WaEpr0rsUNnRyW4JvWM39xPpcmII
gnwGQ9ygLiGCj8OvQ86vAGgghkzBopSdFXINoq5EGHpgTP5hv94hSRLpXvccRbMN
zsRN5b6BHf60ZSBIfmSmsmMUefwWUjk2JFBZwIgQFdXS/GNcgcNEzLBuyAW3Xd5w
sMQpSDrCmG7LlK/gelKkROYdFR6e2c2HDUvUOMt28RWFihlWGc/+GdpGBc3btxYH
d9nuuS+DwMj2SJ1rMwA/Bfnqsvy+pIi/w+c/Tp1gKFzifgKKG7nJWAJ/gwNTgJvg
kcOjmbPQf47evjvaojrkxRgKe8jLeGKwo7M2lwIDAQABAoIBAEKhMB8BEWzQWNCk
UkVTWvQvZkWleRJgd3ttL5FieaO+wuUL9AdXWirWt7AkYMcaJt422xd6OCFdyMBH
CarROdDAjKBYTRiAVIJ1ys/opB8s4oVEomGVC+u5/+VcsMc7/zBOCtKJQB+10GqF
mN2UBSVR93qtRL8+on75HmeFtktk0c1tM8YsoESb7fWjgvpDEimSalVucnwbKp2e
TcEGuxM64cTojY6paKtRydgvbkWENv99Lkgwv6tw5gIyznoasqAwXRrAaA9AbQOb
VCCHxdYp1SUmhS+vXAjrhBWc1vDDEFHmrL1xMz5ywWrGch8D+u65NVzyNfmVm2u7
c8DBRTECgYEA/VippHDOZMflfWfPTvPYZr3mxMhanMVcKthtZGjbzwwINpseOdcY
znaWygfXEPNvMODptgGXSElJDcN+VflgBbJ57TqYvE87v8jIlJ+D1doM3zeQNuot
h+XvS9skO69P044Pmkmcliz69Q7R9bU8qDVXZyHGRVQR3YX198v7TEcCgYEAyWTo
Uiej2sTiIZA1MrQb143yFljAkqfOSu/nBBnputnEya7RBJXVENPgvphtTusXviAO
uWb9CrLwWLUFBp6TN0efI8AoFmNT3CBFHfg3bW3Em1YAkwmrQ3Dm456vEKjfMVjB
7wJtKaWOH3p7/ik6KD7uoAGDODVQdPxdIRyw+zECgYEA1Os6D7i6zVpu1dl0Em+/
dIGvO70C4nTABEZGkbfK3JTJJlNxsLzE3WgvTHYQWu+siFDOOqfVo+vrmMSvHcRq
3f7kl+rCSKjylzlA0h/J5eXPIZ6J9o0TXP5zAbaYGg05spvXIx0wm8oL0/7zmGQM
KXZDEasB/mwsY5fdY7esaKsCgYEArN7oKLUMClqb/NFrSKWfjIy0dAgk7P4Lrvl0
pGmV3qTVLYXYtwXiCXrF3PS8R1S3YaTk3rKPnGJyusJPmRn/JiFdcfOctXL3Zelx
SsNo2I6zh97vyUcwckh0eIgan8NFKneUqJO9nlUUxOJ/knBTEn7KmCAUQehJstF5
I1YceNECgYEA1AJnWFjhivN5OYG8ZdoufzV6g8vjEefTnYlXawaQQ8p/GjHUhfYG
11Rxd44BkRdZyVvl6LEcWpIE1l+yqkUr9kNA33I1dsZIM9oxKeJ4M8pIkOv47CFA
aizM/2w0dLFN54ZNB6H+bqaVOAfGOKPS6fR1BjjGjNdoBSJxhx0IEtE=
-----END RSA PRIVATE KEY-----"""

PREDICT_API_KEY = "6b379d451576206d0578cd35070d59c71682"

def get_kalshi_auth_headers(method: str, path: str) -> dict:
    timestamp = str(int(time.time() * 1000))
    msg = timestamp + method.upper() + path
    
    private_key = serialization.load_pem_private_key(
        KALSHI_PRIVATE_KEY_PEM.encode(),
        password=None
    )
    
    signature = private_key.sign(
        msg.encode(),
        padding.PKCS1v15(),
        hashes.SHA256()
    )
    
    sig_b64 = base64.b64encode(signature).decode()
    
    return {
        "KALSHI-ACCESS-KEY": KALSHI_API_KEY_ID,
        "KALSHI-ACCESS-SIGNATURE": sig_b64,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "Content-Type": "application/json"
    }

def get_predict_auth_headers() -> dict:
    return {
        "x-api-key": PREDICT_API_KEY,
        "Accept": "application/json"
    }


# ════════════════════════════════════════════════════════════════
# MARKET CATEGORIZATION
# ════════════════════════════════════════════════════════════════
# Keywords por categoría — orden importa (más específico primero)
# Keywords by category — Sports first so team names don't match Politics/Tech keywords
_CAT_RULES: List[tuple] = [
    # Sports — checked first to avoid 'warriors'→'war', 'rockets'→tech, etc.
    ("Sports", [
        "nba", "nfl", "mlb", "nhl", "mls",
        "basketball", "baseball", "hockey", "tennis", "golf",
        "super bowl", "world series", "stanley cup",
        "conference finals", "conference champion", "conference semi",
        "eastern conference", "western conference",
        "playoffs", "championship", "all-star", "all star",
        "copa", "fifa", "world cup winner", "premier league", "la liga",
        "bundesliga", "serie a", "champions league", "europa league",
        "wimbledon", "formula 1", "mma", "ufc", "boxing",
        "olympic games", "tour de france",
        # Team/sport-specific — order matters
        "lakers", "celtics", "warriors", "nets", "bulls", "hawks",
        "pacers", "bucks", "heat", "cavaliers", "pistons", "wizards",
        "hornets", "knicks", "raptors", "76ers", "magic", "pacers",
        "nuggets", "clippers", "suns", "jazz", "spurs", "rockets",
        "mavericks", "timberwolves", "grizzlies", "pelicans",
        "thunder", "blazers", "kings", "wolves",
        # Generic sports terms (word-bounded via space/start match)
        " mvp", "nba mvp", " draft ", " season ",
        "football match", "soccer match", "win the nba", "win the nfl",
        "win the mlb", "win the nhl", "win the super", "win the stanley",
        "win the world cup", "win the copa", "win the league",
    ]),
    # Crypto
    ("Crypto", [
        "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto",
        "blockchain", "defi", "nft", "airdrop", "altcoin",
        "coinbase", "binance", "doge", "dogecoin", "xrp", "ripple",
        "cardano", "ada", "polygon", "matic", "avalanche", "avax",
        "chainlink", "uniswap", "polkadot",
        "litecoin", "shiba", "pepe", "memecoin", "satoshi",
        "stablecoin", "usdt", "usdc", "web3",
        "monad", "megaeth", "opensea", "ftx", "celsius", "fdv",
        "market cap", "layer2", "layer 2", " l2 ", "rollup",
    ]),
    # Politics
    ("Politics", [
        "trump", "biden", "harris", "democrat", "republican", "election",
        "president", "congress", "senate", "primary", "nominee",
        "putin", "zelensky", "ukraine", "russia",
        " war ", "ceasefire", "military strike", "invasion",
        "tariff", "sanction", "legislation", "supreme court",
        "governor", "prime minister", "parliament",
        "brexit", "geopolitics", "treaty", "diplomacy",
        "white house", "fbi", "doj", "impeach",
        "deportation", "immigration", "pentagon",
        "g20", "g7", "united nations",
        "xi jinping", "modi", "macron", "scholz", "sunak",
        "nato", "presidential", "2028 republican", "2028 democrat",
        "2026 election", "2028 election",
    ]),
    # Economy
    ("Economy", [
        "federal reserve", "interest rate", "inflation", "cpi",
        "gdp", "recession", "unemployment", "jobs report", "nonfarm",
        "treasury", "yields", "mortgage",
        "s&p 500", "nasdaq", "dow jones", "stock market", "ipo",
        "earnings", "merger", "acquisition",
        "crude oil", "energy price", "gas price", "commodity",
        "trade balance", "trade deficit", "national debt",
    ]),
    # Tech
    ("Tech", [
        "artificial intelligence", "gpt", "llm", "openai",
        "google", "apple", "microsoft", "meta", "amazon", "nvidia",
        "tesla", "spacex", "starship", "nasa",
        "iphone", "android", "semiconductor", "quantum computing",
        "autonomous vehicle", "self-driving", "electric vehicle",
        "turing test", "nuclear fusion", "cybersecurity",
        "deepmind", "anthropic", "claude", "gemini",
        "gta vi", "gta 6", "video game", "playstation", "xbox",
    ]),
]

def classify_category(question: str) -> str:
    t = " " + question.lower() + " "  # pad for word-boundary detection
    for cat, keywords in _CAT_RULES:
        for kw in keywords:
            if kw in t:
                return cat
    return "Other"


# ════════════════════════════════════════════════════════════════
# EXPIRY DATE EXTRACTION
# ════════════════════════════════════════════════════════════════
_MONTH_NUMS = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}

def extract_expiry(question: str, close_time: Optional[str] = None) -> Optional[str]:
    """
    Returns ISO date string YYYY-MM-DD, or None.
    Priority: close_time from API → patterns in title.
    """
    # 1. Use close_time from Polymarket/Opinion API directly
    if close_time:
        try:
            # Handle various formats: ISO8601, Unix timestamp
            if close_time.isdigit() or (close_time.lstrip("-").replace(".", "").isdigit()):
                ts = float(close_time)
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                return dt.strftime("%Y-%m-%d")
            # ISO 8601 — strip fractional seconds and Z
            ct = re.sub(r"\.\d+", "", close_time).replace("Z", "+00:00")
            dt = datetime.fromisoformat(ct)
            return dt.strftime("%Y-%m-%d")
        except Exception:
            pass

    t = question.lower()

    # 2. "by December 31, 2026" / "by Dec 31 2026"
    m = re.search(r'by\s+(?:the\s+end\s+of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|'
                  r'apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|'
                  r'oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[,.]?\s*(\d{1,2})[,.]?\s*(20\d{2})', t)
    if m:
        month = _MONTH_NUMS.get(m.group(1)[:3], 12)
        return f"{m.group(3)}-{month:02d}-{int(m.group(2)):02d}"

    # 3. "before 2027" → Dec 31 2026
    m = re.search(r'before\s+(20\d{2})', t)
    if m:
        return f"{int(m.group(1)) - 1}-12-31"

    # 4. "by end of 2026" / "in 2026" / "by 2026"
    m = re.search(r'(?:by\s+(?:end\s+of\s+)?|in\s+|before\s+end\s+of\s+)(20\d{2})', t)
    if m:
        return f"{m.group(1)}-12-31"

    # 5. "Q1 2026" → Mar 31, "Q2" → Jun 30, etc.
    m = re.search(r'q([1-4])\s*(20\d{2})', t)
    if m:
        qe = {"1": "03-31", "2": "06-30", "3": "09-30", "4": "12-31"}[m.group(1)]
        return f"{m.group(2)}-{qe}"

    # 6. "2025-26" / "2025?26" season → Jun 30 of the second year
    m = re.search(r'20(\d{2})[\-?/](\d{2})', t)
    if m:
        year2 = 2000 + int(m.group(2))
        return f"{year2}-06-30"

    # 7. Generic year
    m = re.search(r'\b(20[2-9]\d)\b', t)
    if m:
        return f"{m.group(1)}-12-31"

    return None


# ════════════════════════════════════════════════════════════════
# APR CALCULATION
# ════════════════════════════════════════════════════════════════
def calc_apr(spread_pct: float, expiry_iso: Optional[str]) -> float:
    """
    Annualized APR = (spread / cost_basis) * (365 / days_to_expiry) * 100
    Spread is the raw % price difference between platforms.
    """
    if not expiry_iso or spread_pct <= 0:
        return 0.0
    try:
        expiry_dt = datetime.fromisoformat(expiry_iso)
        now = datetime.now(tz=timezone.utc).replace(tzinfo=None)
        days = max(1, (expiry_dt - now).days)
        # Assume cost basis ≈ 1.0 for max profit direction
        apr = (spread_pct / 100) * (365 / days) * 100
        return round(min(apr, 9999.0), 1)  # cap at 9999%
    except Exception:
        return 0.0


# ════════════════════════════════════════════════════════════════
# LIQUIDITY SCORE (0–100)
# ════════════════════════════════════════════════════════════════
def calc_liquidity_score(volume: float) -> int:
    """
    Logarithmic scale: $0 → 0, $100K → 50, $1M → 75, $10M → 90, $100M → 100
    """
    if volume <= 0:
        return 0
    import math
    score = min(100, int(math.log10(max(1, volume)) * 12.5))
    return score


# ════════════════════════════════════════════════════════════════
# BOOK DEPTH ESTIMATE
# ════════════════════════════════════════════════════════════════
def estimate_book_depth(volume: float) -> int:
    """Rough estimate: 5–15% of total volume is active book depth."""
    return int(volume * 0.08)


# ════════════════════════════════════════════════════════════════
# POLYMARKET LIVE PRICE FETCHER
# ════════════════════════════════════════════════════════════════
_poly_price_cache: Dict[str, tuple] = {}  # slug → (data, timestamp)

async def fetch_poly_market_live(session: aiohttp.ClientSession, slug: str) -> Optional[dict]:
    """Fetch a single Polymarket market by slug to get live prices."""
    cached = _poly_price_cache.get(slug)
    if cached and (time.time() - cached[1]) < PRICE_CACHE_TTL:
        return cached[0]

    try:
        params = {"slug": slug, "limit": 1}
        async with session.get(POLY_URL, params=params,
                               timeout=aiohttp.ClientTimeout(total=8)) as r:
            if r.status != 200:
                return None
            data = await r.json()
            if not data:
                return None
            market = data[0] if isinstance(data, list) else data
            _poly_price_cache[slug] = (market, time.time())
            return market
    except Exception:
        return None


# ════════════════════════════════════════════════════════════════
# OPINION LABS LIVE PRICE FETCHER
# ════════════════════════════════════════════════════════════════
_op_price_cache: Dict[str, tuple] = {}  # op_id → (yes_price, no_price, timestamp)

async def fetch_op_price_live(session: aiohttp.ClientSession, op_id: str) -> tuple:
    """Fetch live price for an Opinion Labs market."""
    cached = _op_price_cache.get(op_id)
    if cached and (time.time() - cached[2]) < PRICE_CACHE_TTL:
        return cached[0], cached[1]

    # Try latest-price endpoint first
    try:
        # Need yesTokenId — fetch from the market endpoint
        url_mkt = f"{OP_BASE}/market/{op_id}"
        async with session.get(url_mkt, headers=OP_HDR,
                               timeout=aiohttp.ClientTimeout(total=6)) as r:
            if r.status == 200:
                data = await r.json()
                result = data.get("result", {})
                if isinstance(result, dict):
                    yes_tk = str(result.get("yesTokenId", "") or result.get("data", {}).get("yesTokenId", ""))
                    no_tk  = str(result.get("noTokenId",  "") or result.get("data", {}).get("noTokenId",  ""))

                    # inline prices
                    yp = result.get("yesPrice") or result.get("data", {}).get("yesPrice")
                    np_v = result.get("noPrice") or result.get("data", {}).get("noPrice")
                    if yp is not None:
                        try:
                            yp = float(yp)
                            np_v = float(np_v) if np_v is not None else round(1 - yp, 4)
                            _op_price_cache[op_id] = (yp, np_v, time.time())
                            return yp, np_v
                        except Exception:
                            pass

                    # Fallback: fetch by token
                    if yes_tk:
                        url_p = f"{OP_BASE}/token/latest-price"
                        async with session.get(url_p, headers=OP_HDR,
                                               params={"token_id": yes_tk},
                                               timeout=aiohttp.ClientTimeout(total=5)) as rp:
                            if rp.status == 200:
                                pd = await rp.json()
                                price_val = pd.get("result", {}).get("price")
                                # 0.0 means no trades yet — fall through to orderbook
                                if price_val is not None and float(price_val) > 0:
                                    yp = round(float(price_val), 4)
                                    np_v = round(1 - yp, 4)
                                    _op_price_cache[op_id] = (yp, np_v, time.time())
                                    return yp, np_v

                        # Last resort: orderbook midpoint
                        url_b = f"{OP_BASE}/token/orderbook"
                        async with session.get(url_b, headers=OP_HDR,
                                               params={"token_id": yes_tk},
                                               timeout=aiohttp.ClientTimeout(total=5)) as rb:
                            if rb.status == 200:
                                bd = await rb.json()
                                res = bd.get("result", {}) or {}
                                bids, asks = res.get("bids", []), res.get("asks", [])
                                bb = float(bids[0]["price"]) if bids else 0.0
                                ba = float(asks[0]["price"]) if asks else 0.0
                                mid = ((bb + ba) / 2 if bb and ba else bb or ba)
                                if mid > 0:
                                    yp = round(mid, 4)
                                    np_v = round(1 - yp, 4)
                                    _op_price_cache[op_id] = (yp, np_v, time.time())
                                    return yp, np_v
    except Exception:
        pass

    return None, None


# ════════════════════════════════════════════════════════════════
# PAIRS.JSON READER
# ════════════════════════════════════════════════════════════════
_PAIRS_RAW_URL = "https://raw.githubusercontent.com/Kowalskk/prophetlabs/main/pairs.json"
_pairs_remote_cache: dict = {}
_pairs_remote_ts: float = 0.0

def load_pairs_db() -> dict:
    """Read the pairs.json state file written by main.py.

    On serverless (Vercel) there is no local scanner writing the file,
    so fall back to the copy committed to GitHub."""
    global _pairs_remote_cache, _pairs_remote_ts
    candidates = [
        PAIRS_FILE,
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__)))), "pairs.json"),
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass

    if time.time() - _pairs_remote_ts < 300 and _pairs_remote_cache:
        return _pairs_remote_cache
    try:
        import urllib.request
        with urllib.request.urlopen(_PAIRS_RAW_URL, timeout=10) as r:
            _pairs_remote_cache = json.loads(r.read().decode("utf-8"))
            _pairs_remote_ts = time.time()
            return _pairs_remote_cache
    except Exception:
        pass
    return {"approved": {}, "rejected": {}, "pending": {}}


def parse_pair_key(key: str) -> tuple:
    """Extract poly_slug and op_id from a pairs.json key like 'slug||op_id'."""
    parts = key.split("||", 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return key, ""


# ════════════════════════════════════════════════════════════════
# POLYMARKET BULK FETCH (for enriching pairs)
# ════════════════════════════════════════════════════════════════
_poly_bulk_cache: Dict[str, dict] = {}   # slug → market_raw
_poly_bulk_ts: float = 0.0

async def ensure_poly_bulk_cache(session: aiohttp.ClientSession):
    """Fetch all Polymarket markets and cache by slug for fast lookup."""
    global _poly_bulk_ts
    if time.time() - _poly_bulk_ts < 60:  # 1 min cache
        return

    all_markets = []
    for pg in range(1, POLY_PAGES + 1):
        params = {"active": "true", "closed": "false",
                  "limit": POLY_PP, "offset": (pg - 1) * POLY_PP}
        try:
            async with session.get(POLY_URL, params=params,
                                   timeout=aiohttp.ClientTimeout(total=12)) as r:
                if r.status != 200:
                    break
                data = await r.json()
                if not data:
                    break
                all_markets.extend(data)
        except Exception:
            break

    for m in all_markets:
        slug = m.get("slug", "") or m.get("market_slug", "")
        cond = m.get("conditionId", "")
        mid  = slug or cond or str(m.get("id", ""))
        if mid:
            _poly_bulk_cache[mid] = m

    _poly_bulk_ts = time.time()


def _parse_poly_prices(market_raw: dict) -> tuple:
    """Extract yes_price, no_price, volume, close_time from raw Polymarket market."""
    out_str   = market_raw.get("outcomes", "")
    price_str = market_raw.get("outcomePrices", "")
    try:
        outs = json.loads(out_str) if isinstance(out_str, str) else (out_str or [])
        prs  = json.loads(price_str) if isinstance(price_str, str) else (price_str or [])
    except Exception:
        outs, prs = [], []

    yes_p, no_p = 0.5, 0.5
    for i, o in enumerate(outs):
        if str(o).lower() in ("yes", "up") and i < len(prs):
            try:
                yes_p = float(prs[i])
            except Exception:
                pass
        elif str(o).lower() in ("no", "down") and i < len(prs):
            try:
                no_p = float(prs[i])
            except Exception:
                pass

    vol = 0.0
    try:
        vol = float(market_raw.get("volume", 0) or 0)
    except Exception:
        pass

    close_time = market_raw.get("endDate") or market_raw.get("end_date_iso") or None

    return round(yes_p, 4), round(no_p, 4), vol, close_time


# ════════════════════════════════════════════════════════════════
# KALSHI & PREDICT LIVE PRICE FETCHERS
# ════════════════════════════════════════════════════════════════
import difflib

# Caches for bulk market data to avoid rate limits
_kalshi_bulk_cache: List[dict] = []
_kalshi_bulk_ts: float = 0.0

_predict_bulk_cache: List[dict] = []
_predict_bulk_ts: float = 0.0

KALSHI_URL = "https://api.elections.kalshi.com/trade-api/v2/markets"
PREDICT_TESTNET_URL = "https://api-testnet.predict.fun/v1/markets"

async def ensure_kalshi_bulk_cache(session: aiohttp.ClientSession):
    global _kalshi_bulk_cache, _kalshi_bulk_ts
    if time.time() - _kalshi_bulk_ts < 300:  # 5 min cache (bulk dump is heavy)
        return
    path = "/trade-api/v2/markets"
    try:
        markets, cursor = [], None
        for _ in range(15):  # up to 15 pages x 1000 (sports parlays flood the head)
            headers = get_kalshi_auth_headers("GET", path)
            params = {"status": "open", "limit": 1000}
            if cursor:
                params["cursor"] = cursor
            async with session.get(KALSHI_URL, params=params, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status != 200:
                    break
                data = await r.json()
                markets.extend(data.get("markets", []))
                cursor = data.get("cursor")
                if not cursor:
                    break
        if markets:
            _kalshi_bulk_cache = markets
            _kalshi_bulk_ts = time.time()
    except Exception as e:
        print(f"Kalshi fetch error: {e}")

async def ensure_predict_bulk_cache(session: aiohttp.ClientSession):
    global _predict_bulk_cache, _predict_bulk_ts
    if time.time() - _predict_bulk_ts < 60:  # 60s cache
        return
    try:
        # Pagination is first/after (docs: dev.predict.fun), not limit/cursor
        headers = get_predict_auth_headers()
        PREDICT_MAINNET_URL = "https://api.predict.fun/v1/markets"
        items, cursor = [], None
        for _ in range(10):  # up to 10 pages x 100, sorted by 24h volume
            params = {"first": "100", "status": "OPEN", "sort": "VOLUME_24H_DESC"}
            if cursor:
                params["after"] = cursor
            async with session.get(PREDICT_MAINNET_URL, params=params, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status != 200:
                    break
                data = await r.json()
                page = data.get("data", []) if hasattr(data, "get") else (data if isinstance(data, list) else [])
                items.extend(page)
                cursor = data.get("cursor") if hasattr(data, "get") else None
                if not cursor or not page:
                    break
        if items:
            # Titles are outcome-level ("Australia"); the event text lives in question
            for m in items:
                m["_combo"] = f"{m.get('question') or ''} {m.get('title') or ''}".strip()
            _predict_bulk_cache = items
            _predict_bulk_ts = time.time()
    except Exception as e:
        print(f"Predict fetch error: {e}")

_MATCH_STOP = {"will", "the", "win", "wins", "won", "before", "above", "below",
               "with", "than", "more", "less", "this", "that", "what", "when"}

def _match_market(title: str, markets: List[dict], title_key: str = "title") -> Optional[dict]:
    """Fuzzy match a title against a list of markets.

    Keyword prefilter first — SequenceMatcher over tens of thousands of
    titles is too slow and sports parlays drown out everything else."""
    if not title or not markets:
        return None
    title_lower = title.lower()
    words = {w for w in re.findall(r"[a-z0-9$]+", title_lower)
             if len(w) > 3 and w not in _MATCH_STOP}
    if not words:
        return None

    t_years = set(re.findall(r"\b20\d\d\b", title_lower))
    candidates = []
    for m in markets:
        m_title = (m.get(title_key) or m.get("question") or "").lower()
        if not m_title:
            continue
        # Different explicit years ⇒ different events ("2028 US election"
        # must never match "2026 Peruvian election")
        m_years = set(re.findall(r"\b20\d\d\b", m_title))
        if t_years and m_years and not (t_years & m_years):
            continue
        overlap = len(words & set(re.findall(r"[a-z0-9$]+", m_title)))
        if overlap >= 2 or (overlap >= 1 and len(words) <= 2):
            candidates.append((overlap, m, m_title))
    if not candidates:
        return None
    candidates.sort(key=lambda c: -c[0])

    best_match, best_ratio = None, 0.0
    for _, m, m_title in candidates[:300]:
        ratio = difflib.SequenceMatcher(None, title_lower, m_title).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_match = m

    if best_ratio > 0.45:  # Arbitrary threshold for rough matches
        return best_match
    return None

_KALSHI_SEARCH_URL = "https://api.elections.kalshi.com/v1/search/series"
_kalshi_pair_cache: Dict[str, tuple] = {}   # title → (market|None, ts)

async def kalshi_search_market(session: aiohttp.ClientSession, title: str) -> Optional[dict]:
    """Targeted Kalshi lookup: text search → event markets → fuzzy match.

    The bulk /markets dump is flooded by sports parlays, so niche markets
    (politics, crypto) never appear there. Kalshi's site search does the
    heavy lifting instead."""
    if not title:
        return None
    cached = _kalshi_pair_cache.get(title)
    if cached and time.time() - cached[1] < 600:
        return cached[0]

    best = None
    try:
        words = [w for w in re.findall(r"[A-Za-z0-9$]+", title)
                 if len(w) > 3 and w.lower() not in _MATCH_STOP][:6]
        if words:
            async with session.get(_KALSHI_SEARCH_URL, params={"query": " ".join(words)},
                                   timeout=aiohttp.ClientTimeout(total=6)) as r:
                if r.status == 200:
                    page = (await r.json()).get("current_page") or []
                    tickers = []
                    for it in page:
                        et = it.get("event_ticker")
                        if et and et not in tickers:
                            tickers.append(et)
                    cand = []
                    for et in tickers[:3]:
                        h = get_kalshi_auth_headers("GET", "/trade-api/v2/markets")
                        async with session.get(KALSHI_URL,
                                               params={"event_ticker": et, "status": "open", "limit": 100},
                                               headers=h, timeout=aiohttp.ClientTimeout(total=6)) as r2:
                            if r2.status == 200:
                                cand += (await r2.json()).get("markets", [])
                    # Market titles are often generic ("Republican nominee?") with the
                    # candidate in yes_sub_title — match against the combination.
                    # Guard: "who will RUN for" markets price candidacy, not victory —
                    # textually near-identical to "win the nomination" but a different bet.
                    tl = title.lower()
                    cand = [m for m in cand
                            if not ("run for" in (m.get("title") or "").lower()
                                    and "run" not in tl)]
                    for m in cand:
                        m["_combo"] = f"{m.get('title','')} {m.get('yes_sub_title','')}"
                    best = _match_market(title, cand, "_combo")
    except Exception:
        pass

    _kalshi_pair_cache[title] = (best, time.time())
    return best

def _extract_kalshi_prices(market: dict) -> tuple:
    """Returns (yes_price, no_price, volume) out of Kalshi market obj."""
    if not market:
        return 0.5, 0.5, 0.0
    yd = market.get("yes_bid_dollars")
    nd = market.get("no_bid_dollars")
    
    yes_p = float(yd) if yd is not None else (market.get("yes_bid", 50) / 100)
    no_p = float(nd) if nd is not None else (market.get("no_bid", 50) / 100)
    vol = float(market.get("volume_24h_fp") or market.get("volume_24h") or 0)
    return round(yes_p, 4), round(no_p, 4), vol

def _extract_predict_prices(market: dict) -> tuple:
    """Returns (yes_price, no_price, volume) out of Predict market obj.

    Prices live in outcomes[0].bestBid/bestAsk (docs: dev.predict.fun)."""
    if not market:
        return 0.5, 0.5, 0.0
    outcomes = market.get("outcomes") or []
    yes_p = None
    if outcomes:
        o = outcomes[0]
        bid = (o.get("bestBid") or {}).get("price")
        ask = (o.get("bestAsk") or {}).get("price")
        bid = float(bid) if bid is not None else 0.0
        ask = float(ask) if ask is not None else 0.0
        if bid and ask:
            yes_p = round((bid + ask) / 2, 4)
        elif bid or ask:
            yes_p = round(bid or ask, 4)
    if yes_p is None:
        yes_p = float(market.get("lastPrice") or 0.5)
    no_p = round(1.0 - yes_p, 4)
    vol = float(market.get("volume24hUsd") or market.get("volume24h") or 0.0)
    return yes_p, no_p, vol

# ════════════════════════════════════════════════════════════════
# BUILD PAIR RESPONSE OBJECT
# ════════════════════════════════════════════════════════════════
async def build_pair_response(
    pair_key: str,
    pair_data: dict,
    session: aiohttp.ClientSession,
    pair_index: int,
    fetch_live_prices: bool = True,
) -> Optional[dict]:
    """
    Convert a pairs.json approved entry into the frontend-compatible format.
    """
    poly_slug, op_id = parse_pair_key(pair_key)
    poly_q = pair_data.get("poly_q", "")
    op_q   = pair_data.get("op_q", "")

    # ── Get Polymarket data from bulk cache ──
    poly_raw = _poly_bulk_cache.get(poly_slug, {})
    poly_yes, poly_no, poly_vol, close_time = _parse_poly_prices(poly_raw)

    if not poly_raw:
        # Fallback — minimal from pair record
        poly_yes, poly_no = 0.5, 0.5
        poly_vol = 0.0
        close_time = None

    # ── Get Opinion Labs live price ──
    op_yes, op_no = None, None
    if fetch_live_prices and op_id:
        op_yes, op_no = await fetch_op_price_live(session, op_id)

    if op_yes is None:
        op_yes = 0.5
        op_no  = 0.5
        
    # ── Get Kalshi and Predict data from bulk cache ──
    # Note: ensure_* functions are called once at the start of get_pairs_cached
    kalshi_match = _match_market(poly_q or op_q, _kalshi_bulk_cache, "title")
    if not kalshi_match and fetch_live_prices:
        kalshi_match = await kalshi_search_market(session, poly_q or op_q)
    kalshi_yes, kalshi_no, kalshi_vol = _extract_kalshi_prices(kalshi_match)
    kalshi_name = kalshi_match.get("title", "") if kalshi_match else "—"
    if kalshi_match and kalshi_match.get("yes_sub_title"):
        kalshi_name = f"{kalshi_name} — {kalshi_match['yes_sub_title']}"
    
    predict_match = _match_market(poly_q or op_q, _predict_bulk_cache, "_combo")
    predict_yes, predict_no, predict_vol = _extract_predict_prices(predict_match)
    predict_name = "—"
    if predict_match:
        predict_name = predict_match.get("question") or predict_match.get("title") or "—"

    # ── Derived fields ──
    # Now spread needs to be calculated across all 4 platforms!
    # For MVP of full integration, we'll find max difference among available YES prices.
    all_yes_prices = [poly_yes, op_yes, kalshi_yes, predict_yes]
    valid_yes_prices = [p for p in all_yes_prices if p is not None and p > 0 and p < 1 and p != 0.5]
    
    if len(valid_yes_prices) >= 2:
        spread_decimal = max(valid_yes_prices) - min(valid_yes_prices)
    else:
        spread_decimal = abs(op_yes - poly_yes) # Fallback to original
        
    spread_pct = round(spread_decimal * 100, 2)

    # Simplified profit for the original direction check (can expand in frontend)
    dir1_cost = poly_yes + op_no   
    dir2_cost = poly_no + op_yes   
    min_cost = min(dir1_cost, dir2_cost)
    profit_pct = round((1 - min_cost) * 100, 2)

    expiry = extract_expiry(poly_q or op_q, close_time)
    apr = calc_apr(spread_pct, expiry)
    category = classify_category(poly_q or op_q)

    # Combined volume
    op_vol = 0.0  
    total_vol = poly_vol + op_vol + kalshi_vol + predict_vol

    liquidity = calc_liquidity_score(total_vol)
    book_depth = estimate_book_depth(total_vol)

    # Status tag
    if spread_pct >= 10 or profit_pct >= 5:
        status = "hot"
    else:
        status = "active"

    # Unified event name
    event = poly_q or op_q
    if len(event) > 80:
        event = event[:77] + "..."

    roi = round((1 - min_cost) * 100, 2) if min_cost < 1 else 0.0

    return {
        "id": pair_index,
        "pair_key": pair_key,
        "event": event,
        "category": category,
        "names": {
            "polymarket": poly_q,
            "opinion": op_q,
            "kalshi": kalshi_name,
            "predict": predict_name
        },
        "prices": {
            "polymarket": {"yes": poly_yes, "no": poly_no},
            "opinion": {"yes": op_yes, "no": op_no},
            "kalshi": {"yes": kalshi_yes, "no": kalshi_no},
            "predict": {"yes": predict_yes, "no": predict_no}
        },
        "spread": round(spread_decimal, 4),
        "spreadPct": spread_pct,
        "apr": apr,
        "volume": int(total_vol),
        "expiry": expiry,
        "status": status,
        "liquidity": liquidity,
        "bookDepth": book_depth,
        "roi": roi,
        "similarity": round(pair_data.get("sim", 0), 2),
        "fees": {
            "polymarket": POLY_FEE,
            "opinion": OP_FEE,
            "kalshi": 0.01,
            "predict": 0.015
        },
        "poly_slug": poly_slug,
        "op_id": op_id,
        "approved_at": pair_data.get("approved_at"),
        "last_updated": time.time(),
    }


# ════════════════════════════════════════════════════════════════
# IN-MEMORY CACHE FOR BUILT PAIRS
# ════════════════════════════════════════════════════════════════
_pairs_cache: List[dict] = []
_pairs_cache_ts: float = 0.0
_pairs_cache_lock = asyncio.Lock() if False else None  # created at startup

async def get_pairs_cached(session: aiohttp.ClientSession, force: bool = False) -> List[dict]:
    """
    Return cached pairs list. Refreshes every PRICE_CACHE_TTL seconds or on force.
    """
    global _pairs_cache, _pairs_cache_ts

    if not force and (time.time() - _pairs_cache_ts) < PRICE_CACHE_TTL and _pairs_cache:
        return _pairs_cache

    db = load_pairs_db()
    approved = db.get("approved", {})
    print(f"DEBUG: load_pairs_db found {len(approved)} approved pairs")

    if not approved:
        return []

    # Ensure all bulk caches are warm at once
    await asyncio.gather(
        ensure_poly_bulk_cache(session),
        ensure_kalshi_bulk_cache(session),
        ensure_predict_bulk_cache(session),
        return_exceptions=True
    )
    
    print(f"DEBUG: POLY_CACHE={len(_poly_bulk_cache)}, KALSHI_CACHE={len(_kalshi_bulk_cache)}, PREDICT_CACHE={len(_predict_bulk_cache)}")

    # Build all pairs concurrently (limit concurrency to avoid hammering OP API)
    semaphore = asyncio.Semaphore(10)

    async def build_with_sem(idx, key, data):
        try:
            async with semaphore:
                return await build_pair_response(key, data, session, idx + 1)
        except Exception as e:
            print(f"ERROR: build_pair_response failed for {key}")
            traceback.print_exc()
            return None

    tasks = [build_with_sem(i, k, v) for i, (k, v) in enumerate(approved.items())]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    for i, res in enumerate(results):
        if isinstance(res, Exception):
            print(f"DEBUG: Task {i} failed: {res}")
        elif res is None:
            # Check if build_pair_response returned None
            pass

    pairs = [r for r in results if isinstance(r, dict)]
    print(f"DEBUG: Successfully built {len(pairs)} response objects")

    # Sort by spread descending (best opportunity first)
    pairs.sort(key=lambda x: x.get("spread", 0), reverse=True)

    _pairs_cache = pairs
    _pairs_cache_ts = time.time()
    return pairs


# ════════════════════════════════════════════════════════════════
# WEBSOCKET MANAGER
# ════════════════════════════════════════════════════════════════
class WSManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, message: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


ws_manager = WSManager()


# ════════════════════════════════════════════════════════════════
# FASTAPI APP
# ════════════════════════════════════════════════════════════════
app = FastAPI(
    title="ProphetLabs API",
    description="Arbitrage scanner entre Polymarket y Opinion Labs",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # En producción limitar al dominio del frontend
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# aiohttp session compartida
_session: Optional[aiohttp.ClientSession] = None


@app.on_event("startup")
async def startup():
    global _session
    connector = aiohttp.TCPConnector(limit=20, keepalive_timeout=30)
    _session = aiohttp.ClientSession(connector=connector)
    # Warm up cache
    asyncio.create_task(ws_broadcast_loop())
    print("✅ ProphetLabs API started — http://localhost:8000")
    print("   GET  /api/pairs")
    print("   GET  /api/pairs/{id}")
    print("   GET  /api/stats")
    print("   WS   /ws/prices")


@app.on_event("shutdown")
async def shutdown():
    global _session
    if _session:
        await _session.close()


# ════════════════════════════════════════════════════════════════
# REST ENDPOINTS
# ════════════════════════════════════════════════════════════════

# ════════════════════════════════════════════════════════════════
# PROXY ENDPOINTS (to avoid CORS)
# ════════════════════════════════════════════════════════════════

@app.get("/api/kalshi/markets")
async def proxy_kalshi_markets():
    """Proxy Kalshi markets with RSA signing."""
    path = "/trade-api/v2/markets"
    headers = get_kalshi_auth_headers("GET", path)
    params = {"status": "open", "limit": 200}
    try:
        async with _session.get(KALSHI_URL, params=params, headers=headers) as r:
            return await r.json()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.get("/api/predict/markets")
async def proxy_predict_markets():
    """Proxy Predict markets with API key."""
    headers = get_predict_auth_headers()
    url = "https://api.predict.fun/v1/markets"
    try:
        async with _session.get(url, params={"limit": 100}, headers=headers) as r:
            return await r.json()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

@app.get("/api/pairs")
async def get_pairs(
    category: Optional[str] = None,
    profitable_only: bool = False,
    min_spread: float = 0.0,
    min_volume: float = 0.0,
    min_liquidity: int = 0,
    max_expiry_days: Optional[int] = None,
    limit: int = 200,
):
    """
    Lista de pares aprobados con precios en vivo.

    Query params:
    - category: Crypto | Politics | Economy | Sports | Tech | Other
    - profitable_only: solo pares con spread > 0
    - min_spread: spread mínimo (decimal, e.g. 0.01 = 1%)
    - min_volume: volumen mínimo en USD
    - min_liquidity: score de liquidez mínimo (0-100)
    - max_expiry_days: solo mostrar mercados que expiran en N días
    - limit: max resultados
    """
    pairs = await get_pairs_cached(_session)

    # Apply filters
    if category and category.lower() != "all":
        pairs = [p for p in pairs if p.get("category", "").lower() == category.lower()]

    if profitable_only:
        pairs = [p for p in pairs if p.get("spread", 0) > 0.001]

    if min_spread > 0:
        pairs = [p for p in pairs if p.get("spread", 0) >= min_spread]

    if min_volume > 0:
        pairs = [p for p in pairs if p.get("volume", 0) >= min_volume]

    if min_liquidity > 0:
        pairs = [p for p in pairs if p.get("liquidity", 0) >= min_liquidity]

    if max_expiry_days is not None:
        now = datetime.now()
        cutoff = now.timestamp() + max_expiry_days * 86400
        filtered = []
        for p in pairs:
            expiry = p.get("expiry")
            if expiry:
                try:
                    exp_dt = datetime.fromisoformat(expiry)
                    if exp_dt.timestamp() <= cutoff:
                        filtered.append(p)
                except Exception:
                    filtered.append(p)
            else:
                filtered.append(p)
        pairs = filtered

    return {
        "pairs": pairs[:limit],
        "total": len(pairs),
        "cached_at": _pairs_cache_ts,
        "cache_age_seconds": round(time.time() - _pairs_cache_ts, 1),
    }


@app.get("/api/pairs/{pair_id}")
async def get_pair_detail(pair_id: str):
    """
    Detalle de un par. pair_id puede ser el índice numérico o el pair_key directo.
    Siempre refresca precios en vivo para este endpoint.
    """
    pairs = await get_pairs_cached(_session)

    # Try numeric id
    target = None
    if pair_id.isdigit():
        idx = int(pair_id)
        matches = [p for p in pairs if p.get("id") == idx]
        if matches:
            target = matches[0]
    else:
        # Try pair_key match
        for p in pairs:
            if p.get("pair_key") == pair_id:
                target = p
                break

    if not target:
        return JSONResponse({"error": "Pair not found"}, status_code=404)

    # Re-fetch live prices for this specific pair
    key = target.get("pair_key", "")
    db = load_pairs_db()
    pair_data = db.get("approved", {}).get(key, {})
    if pair_data:
        fresh = await build_pair_response(key, pair_data, _session,
                                          target.get("id", 1),
                                          fetch_live_prices=True)
        if fresh:
            target = fresh

    return target


@app.get("/api/stats")
async def get_stats():
    """Stats generales del sistema."""
    db = load_pairs_db()
    pairs = await get_pairs_cached(_session)

    # Category breakdown
    cat_counts: Dict[str, int] = {}
    hot_count = 0
    total_spread = 0.0
    total_volume = 0

    for p in pairs:
        cat = p.get("category", "Other")
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
        if p.get("status") == "hot":
            hot_count += 1
        total_spread += p.get("spread", 0)
        total_volume += p.get("volume", 0)

    avg_spread = round(total_spread / len(pairs) * 100, 2) if pairs else 0

    # Best opportunities
    top3 = sorted(pairs, key=lambda x: x.get("spread", 0), reverse=True)[:3]

    return {
        "total_approved": len(db.get("approved", {})),
        "total_rejected": len(db.get("rejected", {})),
        "total_pending":  len(db.get("pending", {})),
        "active_pairs":   len(pairs),
        "hot_pairs":      hot_count,
        "avg_spread_pct": avg_spread,
        "total_volume_usd": total_volume,
        "categories": cat_counts,
        "top_opportunities": [
            {
                "event": p.get("event", ""),
                "spread_pct": p.get("spreadPct", 0),
                "apr": p.get("apr", 0),
                "category": p.get("category", ""),
            }
            for p in top3
        ],
        "ws_connected_clients": len(ws_manager.active),
        "engine_running": os.path.exists(PAIRS_FILE),
        "pairs_file_age_seconds": round(time.time() - os.path.getmtime(PAIRS_FILE), 1)
            if os.path.exists(PAIRS_FILE) else None,
        "timestamp": time.time(),
    }


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0", "timestamp": time.time()}


# ════════════════════════════════════════════════════════════════
# WEBSOCKET ENDPOINT — /ws/prices
# ════════════════════════════════════════════════════════════════

@app.websocket("/ws/prices")
async def ws_prices(websocket: WebSocket):
    """
    WebSocket endpoint for real-time price updates.
    Sends updates every WS_BROADCAST_INTERVAL seconds.
    Message format: { "type": "prices", "pairs": [...], "timestamp": ... }
    """
    await ws_manager.connect(websocket)
    try:
        # Send current state immediately on connect
        pairs = await get_pairs_cached(_session)
        await websocket.send_json({
            "type": "snapshot",
            "pairs": pairs,
            "timestamp": time.time(),
        })

        # Keep connection alive — wait for disconnect
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                # Send ping to keep alive
                await websocket.send_json({"type": "ping", "timestamp": time.time()})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        ws_manager.disconnect(websocket)


async def ws_broadcast_loop():
    """Background task: refresh prices and broadcast to all WS clients."""
    await asyncio.sleep(5)  # Initial delay to let API warm up
    while True:
        try:
            if ws_manager.active:
                # Force refresh cache
                pairs = await get_pairs_cached(_session, force=True)
                await ws_manager.broadcast({
                    "type": "prices",
                    "pairs": pairs,
                    "timestamp": time.time(),
                })
        except Exception as e:
            print(f"  [WS Broadcast] Error: {e}")
        await asyncio.sleep(WS_BROADCAST_INTERVAL)


# ════════════════════════════════════════════════════════════════
# OPTIONAL: FORCE REFRESH ENDPOINT (para Telegram bot integration)
# ════════════════════════════════════════════════════════════════

@app.post("/api/refresh")
async def force_refresh():
    """Force a cache refresh (llamado cuando main.py detecta nuevos pares)."""
    global _pairs_cache_ts
    _pairs_cache_ts = 0  # invalidate cache
    pairs = await get_pairs_cached(_session, force=True)
    await ws_manager.broadcast({
        "type": "refresh",
        "pairs": pairs,
        "timestamp": time.time(),
    })
    return {"refreshed": True, "pairs_count": len(pairs)}


# ════════════════════════════════════════════════════════════════
# ENTRYPOINT
# ════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="info",
    )
