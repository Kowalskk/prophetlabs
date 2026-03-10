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
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import aiohttp
import uvicorn
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

POLY_PAGES   = 5
POLY_PP      = 100
POLY_FEE     = 0.0217   # 2.17%
OP_FEE       = 0.0      # 0%

# Cuánto tiempo (seg) cachear los precios antes de refrescar
PRICE_CACHE_TTL  = 30
# Intervalo de broadcast WebSocket (segundos)
WS_BROADCAST_INTERVAL = 5


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
        url_mkt = f"{OP_BASE}/market/detail"
        async with session.get(url_mkt, headers=OP_HDR,
                               params={"marketId": op_id},
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
                                if price_val is not None:
                                    yp = round(float(price_val), 4)
                                    np_v = round(1 - yp, 4)
                                    _op_price_cache[op_id] = (yp, np_v, time.time())
                                    return yp, np_v
    except Exception:
        pass

    return None, None


# ════════════════════════════════════════════════════════════════
# PAIRS.JSON READER
# ════════════════════════════════════════════════════════════════
def load_pairs_db() -> dict:
    """Read the pairs.json state file written by main.py."""
    if not os.path.exists(PAIRS_FILE):
        return {"approved": {}, "rejected": {}, "pending": {}}
    try:
        with open(PAIRS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
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
    if time.time() - _kalshi_bulk_ts < 30:  # 30s cache
        return
    try:
        async with session.get(KALSHI_URL, params={"status": "open", "limit": 200}, timeout=aiohttp.ClientTimeout(total=8)) as r:
            if r.status == 200:
                data = await r.json()
                if "markets" in data:
                    _kalshi_bulk_cache = data["markets"]
                    _kalshi_bulk_ts = time.time()
    except Exception as e:
        print(f"Kalshi fetch error: {e}")

async def ensure_predict_bulk_cache(session: aiohttp.ClientSession):
    global _predict_bulk_cache, _predict_bulk_ts
    if time.time() - _predict_bulk_ts < 60:  # 60s cache
        return
    try:
        # Using testnet API (no key required ideally, or just gracefully fallback)
        async with session.get(PREDICT_TESTNET_URL, params={"limit": 100}, timeout=aiohttp.ClientTimeout(total=8)) as r:
            if r.status == 200:
                data = await r.json()
                if hasattr(data, "get") and "data" in data:
                    _predict_bulk_cache = data.get("data", [])
                elif isinstance(data, list):
                    _predict_bulk_cache = data
                _predict_bulk_ts = time.time()
    except Exception as e:
        print(f"Predict fetch error: {e}")

def _match_market(title: str, markets: List[dict], title_key: str = "title") -> Optional[dict]:
    """Fuzzy match a title against a list of markets."""
    if not title or not markets:
        return None
    best_match = None
    best_ratio = 0.0
    title_lower = title.lower()
    for m in markets:
        m_title = m.get(title_key) or m.get("question") or ""
        ratio = difflib.SequenceMatcher(None, title_lower, m_title.lower()).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_match = m
    
    if best_ratio > 0.45:  # Arbitrary threshold for rough matches
        return best_match
    return None

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
    """Returns (yes_price, no_price, volume) out of Predict market obj."""
    if not market:
        return 0.5, 0.5, 0.0
    yes_p = float(market.get("lastPrice") or market.get("bestBid") or 0.5)
    no_p = round(1.0 - yes_p, 4)
    vol = float(market.get("volume24h", 0.0))
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
        
    # ── Get Kalshi and Predict data ──
    await asyncio.gather(
        ensure_kalshi_bulk_cache(session),
        ensure_predict_bulk_cache(session)
    )
    
    kalshi_match = _match_market(poly_q or op_q, _kalshi_bulk_cache, "title")
    kalshi_yes, kalshi_no, kalshi_vol = _extract_kalshi_prices(kalshi_match)
    kalshi_name = kalshi_match.get("title", "") if kalshi_match else "—"
    
    predict_match = _match_market(poly_q or op_q, _predict_bulk_cache, "title")
    predict_yes, predict_no, predict_vol = _extract_predict_prices(predict_match)
    predict_name = predict_match.get("title") or predict_match.get("question") or "—"

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

    # Load pairs.json
    db = load_pairs_db()
    approved = db.get("approved", {})

    if not approved:
        return []

    # Ensure poly bulk cache is warm
    await ensure_poly_bulk_cache(session)

    # Build all pairs concurrently (limit concurrency to avoid hammering OP API)
    semaphore = asyncio.Semaphore(10)

    async def build_with_sem(idx, key, data):
        async with semaphore:
            return await build_pair_response(key, data, session, idx + 1)

    tasks = [build_with_sem(i, k, v) for i, (k, v) in enumerate(approved.items())]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    pairs = [r for r in results if isinstance(r, dict)]

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
        "prophetlabs_api:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="info",
    )
