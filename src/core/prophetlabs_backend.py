"""
╔══════════════════════════════════════════════════════════════════╗
║  ProphetLabs v15.1 — WEBSOCKET + ENHANCED PARSING               ║
║                                                                  ║
║  v15.1 improvements:                                             ║
║   • Polymarket WebSocket for real-time prices                    ║
║   • Opinion parsing: dr-manhattan patterns (binary→cat fallback) ║
║   • Opinion sortBy volume24h for high-liquidity markets first    ║
║   • Inline price extraction from Opinion market listings         ║
║                                                                  ║
║  Exchanges:  Polymarket (Gamma + WS)  +  Opinion Labs (REST)     ║
║  pip install aiohttp python-telegram-bot websockets              ║
╚══════════════════════════════════════════════════════════════════╝
"""

import asyncio, time, json, re, os, sys, hashlib, traceback as tb_mod
from datetime import datetime, timezone
from difflib import SequenceMatcher
from dataclasses import dataclass, field, asdict
from typing import Optional, Dict, List, Any, Tuple
import aiohttp
from telegram import Bot, Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ParseMode

# ── Windows console fix ─────────────────────────────────────────
if sys.platform == "win32":
    for s in [sys.stdout, sys.stderr]:
        try: s.reconfigure(encoding="utf-8", errors="replace")
        except: pass
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

def safe(t):
    """ASCII-safe text for Windows console."""
    return str(t).encode("ascii", errors="replace").decode("ascii") if t else ""


# ════════════════════════════════════════════════════════════════
# CONFIG
# ════════════════════════════════════════════════════════════════
TG_TOKEN  = "8453739671:AAEn_de2-XbZPpFm5FmtBg6ZF6FHs-y2qWQ"
TG_CHAT   = "199703785"           # Private chat (always works)
TG_GROUP  = "-1003712133392"      # Group chat
TG_THREAD = 10                    # Thread ID in group
OP_KEY    = "QR7aUdjPvQ8PcyTKfTZKeeYkwTBLaiTp"

PAIRS_FILE    = "pairs.json"
PATTERNS_FILE = "patterns.json"

# Timing
POLL_DISCOVER = 25.0
POLL_MONITOR  = 4.0
MIN_PROF      = 0.5       # min % profit for arbitrage alert
AUTO_APPROVE  = 0.35      # auto-approve if compatible() passes + sim >= 35%
ALERT_CD      = 300       # alert cooldown seconds

# API limits
POLY_PAGES    = 5         # 500 markets
POLY_PP       = 100
OP_PAGES      = 20        # max pages to try
OP_PP         = 50        # 50 per page (more efficient)
MAX_PRICES    = 50        # max price fetches per cycle
PRICE_TTL     = 15        # price cache TTL seconds
CAT_REFRESH   = 100       # refresh categorical children every N cycles

# LLM Validator (OpenRouter)
# Get free key at https://openrouter.ai/settings/keys
# Models: "google/gemini-2.5-flash-lite-preview-09-2025" (FREE, good)
#         "google/gemini-2.5-flash-lite" ($0.10/$0.40 — fast, cheap)
#         "google/gemini-2.5-flash" ($0.15/$0.60 — best)
#         "deepseek/deepseek-chat-v3-0324:free" (FREE)
#         "meta-llama/llama-4-maverick:free" (FREE)
LLM_KEY       = "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"
LLM_MODEL     = "google/gemini-2.5-flash-lite-preview-09-2025"
LLM_URL       = "https://openrouter.ai/api/v1/chat/completions"
LLM_ENABLED   = True

# ════════════════════════════════════════════════════════════════
# POLYMARKET WEBSOCKET — real-time price updates
# (pattern from dr-manhattan polymarket_ws.py)
# ════════════════════════════════════════════════════════════════
POLY_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
POLY_WS_PING_INTERVAL = 25  # seconds between pings
POLY_WS_RECONNECT_DELAY = 5  # seconds before reconnect
_poly_ws_prices: Dict[str, float] = {}   # token_id -> mid_price (updated by WS)
_poly_ws_subscribed: set = set()          # currently subscribed token_ids
_poly_ws_connected: bool = False
_poly_ws_task: Optional[asyncio.Task] = None


# ════════════════════════════════════════════════════════════════
# DATA MODELS (inspired by dr-manhattan)
# ════════════════════════════════════════════════════════════════
@dataclass
class Market:
    """Unified market representation across exchanges."""
    id: str                     # unique ID on the exchange
    question: str               # human-readable question
    slug: str                   # URL-friendly identifier
    exchange: str               # "polymarket" or "opinion"
    outcomes: List[str]         # ["Yes","No"] or child titles
    token_ids: Dict[str,str]    # outcome -> token_id
    prices: Dict[str,float]     # outcome -> price (0-1)
    volume: float = 0.0
    close_time: Optional[str] = None
    market_type: str = "binary" # "binary" or "child"
    parent_id: str = ""         # for child markets: parent's ID
    parent_title: str = ""      # for child markets: parent's title
    metadata: Dict[str,Any] = field(default_factory=dict)

    @property
    def yes_price(self) -> float:
        for k in ["Yes","YES","Up","UP"]:
            if k in self.prices: return self.prices[k]
        vals = list(self.prices.values())
        return vals[0] if vals else 0.0

    @property
    def no_price(self) -> float:
        for k in ["No","NO","Down","DOWN"]:
            if k in self.prices: return self.prices[k]
        vals = list(self.prices.values())
        return vals[1] if len(vals)>1 else round(1.0-self.yes_price,4)

    @property
    def yes_token(self) -> str:
        for k in ["Yes","YES","Up","UP"]:
            if k in self.token_ids: return self.token_ids[k]
        vals = list(self.token_ids.values())
        return vals[0] if vals else ""

    @property
    def no_token(self) -> str:
        for k in ["No","NO","Down","DOWN"]:
            if k in self.token_ids: return self.token_ids[k]
        vals = list(self.token_ids.values())
        return vals[1] if len(vals)>1 else ""

    @property
    def has_prices(self) -> bool:
        return bool(self.prices) and any(v>0 for v in self.prices.values())

    @property
    def yes_label(self) -> str:
        for k in ["Yes","YES","Up","UP"]:
            if k in self.prices: return k
        return list(self.prices.keys())[0] if self.prices else "YES"

    @property
    def no_label(self) -> str:
        for k in ["No","NO","Down","DOWN"]:
            if k in self.prices: return k
        keys = list(self.prices.keys())
        return keys[1] if len(keys)>1 else "NO"


# ════════════════════════════════════════════════════════════════
# POLYMARKET EXCHANGE — Gamma API
# ════════════════════════════════════════════════════════════════
POLY_URL = "https://gamma-api.polymarket.com/markets"

async def fetch_polymarket(session: aiohttp.ClientSession) -> List[Market]:
    """Fetch all active markets from Polymarket Gamma API."""
    markets = []
    for pg in range(1, POLY_PAGES+1):
        params = {
            "active": "true", "closed": "false",
            "limit": POLY_PP, "offset": (pg-1)*POLY_PP,
        }
        try:
            async with session.get(POLY_URL, params=params, timeout=aiohttp.ClientTimeout(total=12)) as r:
                if r.status != 200: continue
                data = await r.json()
                if not data: break
                for item in data:
                    m = _parse_poly_market(item)
                    if m: markets.append(m)
        except Exception:
            continue
    return markets

def _parse_poly_market(item: dict) -> Optional[Market]:
    """Parse a Polymarket Gamma API market into our Market model."""
    q = item.get("question", "")
    if not q: return None

    slug = item.get("slug", "") or item.get("market_slug", "")
    cond = item.get("conditionId", "")
    mid = slug or cond or str(item.get("id", ""))

    outcomes = []
    token_ids = {}
    prices = {}

    # Parse outcomes from Gamma response
    out_str = item.get("outcomes", "")
    price_str = item.get("outcomePrices", "")
    tokens_raw = item.get("clobTokenIds", "")

    try:
        outs = json.loads(out_str) if isinstance(out_str, str) else (out_str or [])
        prs  = json.loads(price_str) if isinstance(price_str, str) else (price_str or [])
        toks = json.loads(tokens_raw) if isinstance(tokens_raw, str) else (tokens_raw or [])
    except:
        outs, prs, toks = [], [], []

    for i, o in enumerate(outs):
        outcomes.append(o)
        if i < len(toks): token_ids[o] = toks[i]
        if i < len(prs):
            try: prices[o] = round(float(prs[i]), 4)
            except: pass

    if not outcomes or not token_ids:
        return None

    vol = 0.0
    try: vol = float(item.get("volume", 0) or 0)
    except: pass

    return Market(
        id=mid, question=q, slug=slug, exchange="polymarket",
        outcomes=outcomes, token_ids=token_ids, prices=prices,
        volume=vol, close_time=item.get("endDate"),
        market_type="binary",
        metadata={"condition_id": cond, "gamma_id": item.get("id")},
    )


# ════════════════════════════════════════════════════════════════
# POLYMARKET WEBSOCKET — real-time price stream
# (pattern from dr-manhattan polymarket_ws.py + polytrack tutorial)
# No auth needed for market channel — public orderbook data
# ════════════════════════════════════════════════════════════════

async def _poly_ws_loop():
    """Background task: connect to Polymarket WS and stream price updates."""
    global _poly_ws_connected, _poly_ws_prices, _poly_ws_subscribed
    try:
        import websockets
    except ImportError:
        print("⚠️ websockets not installed — using REST polling for Polymarket")
        return

    while True:
        try:
            async with websockets.connect(
                POLY_WS_URL,
                ping_interval=POLY_WS_PING_INTERVAL,
                ping_timeout=10,
                close_timeout=5,
            ) as ws:
                _poly_ws_connected = True
                print("🔌 Polymarket WebSocket connected")

                # Subscribe to any tokens we already know about
                if _poly_ws_subscribed:
                    await _poly_ws_subscribe(ws, _poly_ws_subscribed)

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        _poly_ws_handle_message(msg)
                    except json.JSONDecodeError:
                        pass

        except Exception as e:
            _poly_ws_connected = False
            if "websockets" not in str(type(e).__module__):
                print(f"⚠️ Poly WS error: {type(e).__name__}: {e}")
            await asyncio.sleep(POLY_WS_RECONNECT_DELAY)


async def _poly_ws_subscribe(ws, token_ids: set):
    """Send subscription message for a set of token IDs."""
    if not token_ids:
        return
    msg = json.dumps({
        "assets_ids": list(token_ids),
        "type": "market",
    })
    await ws.send(msg)


def _poly_ws_handle_message(msg: dict):
    """Process incoming WS message and update price cache."""
    event_type = msg.get("event_type", "")

    if event_type == "price_change":
        # price_change contains an array of changes
        for change in msg.get("price_changes", []):
            token_id = change.get("asset_id", "")
            if not token_id:
                continue
            # Extract best bid/ask → compute mid price
            best_bid = _safe_float(change.get("best_bid"))
            best_ask = _safe_float(change.get("best_ask"))
            if best_bid and best_ask:
                mid = round((best_bid + best_ask) / 2, 4)
            elif best_ask:
                mid = round(best_ask, 4)
            elif best_bid:
                mid = round(best_bid, 4)
            else:
                price = _safe_float(change.get("price"))
                if price:
                    mid = round(price, 4)
                else:
                    continue
            _poly_ws_prices[token_id] = mid

    elif event_type == "book":
        # Full orderbook snapshot — extract best bid/ask
        asset_id = msg.get("asset_id", "")
        if not asset_id:
            return
        bids = msg.get("bids", [])
        asks = msg.get("asks", [])
        best_bid = float(bids[0]["price"]) if bids and isinstance(bids[0], dict) else (
            float(bids[0][0]) if bids and isinstance(bids[0], list) else 0.0)
        best_ask = float(asks[0]["price"]) if asks and isinstance(asks[0], dict) else (
            float(asks[0][0]) if asks and isinstance(asks[0], list) else 0.0)
        if best_bid > 0 and best_ask > 0:
            _poly_ws_prices[asset_id] = round((best_bid + best_ask) / 2, 4)
        elif best_ask > 0:
            _poly_ws_prices[asset_id] = round(best_ask, 4)

    elif event_type == "last_trade_price":
        asset_id = msg.get("asset_id", "")
        price = _safe_float(msg.get("price"))
        if asset_id and price:
            _poly_ws_prices[asset_id] = round(price, 4)


def _safe_float(v) -> Optional[float]:
    """Safely convert to float."""
    if v is None:
        return None
    try:
        f = float(v)
        return f if f > 0 else None
    except (ValueError, TypeError):
        return None


def poly_ws_get_price(token_id: str) -> Optional[float]:
    """Get cached WS price for a Polymarket token. Returns None if not available."""
    return _poly_ws_prices.get(token_id)


def poly_ws_update_market_prices(market: Market):
    """Update a Polymarket Market's prices from WebSocket cache if available."""
    updated = False
    for outcome in market.outcomes:
        tid = market.token_ids.get(outcome, "")
        if tid and tid in _poly_ws_prices:
            market.prices[outcome] = _poly_ws_prices[tid]
            updated = True
    return updated


async def poly_ws_ensure_subscribed(token_ids: set):
    """Ensure these token IDs are subscribed on the WS. Called from main loop."""
    global _poly_ws_subscribed
    new_ids = token_ids - _poly_ws_subscribed
    if not new_ids:
        return
    _poly_ws_subscribed |= new_ids
    # Can't send directly here since we don't hold the ws object.
    # The _poly_ws_loop will re-subscribe on next reconnect.
    # For immediate subscription, we'd need a queue — but reconnect handles it.


# ════════════════════════════════════════════════════════════════
# OPINION LABS EXCHANGE — REST API
# (enhanced parsing patterns from dr-manhattan opinion.py lines 200-364)
# ════════════════════════════════════════════════════════════════
OP_BASE  = "https://proxy.opinion.trade:8443/openapi"
OP_HDR   = {"apikey": OP_KEY, "Accept": "application/json"}

# Cache for categorical child markets
_cat_cache: Dict[int, List[Market]] = {}
_cat_ts: float = 0.0

async def fetch_opinion(session: aiohttp.ClientSession, cycle: int) -> List[Market]:
    """Fetch all active markets from Opinion Labs (binary + categorical children).
    Enhanced with dr-manhattan patterns:
    - sortBy=5 (volume 24h) for high-liquidity markets first
    - Inline price extraction from market listing when available
    - Binary/categorical auto-detection with fallback
    """
    global _cat_cache, _cat_ts

    markets = []
    cat_parents = []
    dbg = False  # set True to debug Opinion API

    # Fetch all market types (marketType=2 = ALL), sorted by 24h volume
    for pg in range(1, OP_PAGES+1):
        params = {
            "limit": str(OP_PP), "page": str(pg),
            "marketType": "2", "status": "activated",
            "sortBy": "5",  # Sort by volume24h (dr-manhattan pattern)
        }
        try:
            async with session.get(f"{OP_BASE}/market", headers=OP_HDR, params=params,
                                   timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status != 200:
                    if dbg: print(f"  [DBG] Opinion pg{pg} HTTP {r.status}")
                    continue
                data = await r.json()
                if dbg and pg == 1:
                    print(f"  [DBG] Opinion pg1 keys={list(data.keys())}")
                    res = data.get("result", {})
                    if isinstance(res, dict):
                        print(f"  [DBG] result keys={list(res.keys())}")
                        items_raw = res.get("list", [])
                        print(f"  [DBG] list len={len(items_raw)}")
                        if items_raw and isinstance(items_raw[0], dict):
                            print(f"  [DBG] item[0] keys={list(items_raw[0].keys())}")
                            print(f"  [DBG] item[0] marketType={items_raw[0].get('marketType')}")
                            print(f"  [DBG] item[0] volume24h={items_raw[0].get('volume24h')}")
                res = data.get("result", {})
                items = res.get("list", []) if isinstance(res, dict) else []
                if not items:
                    if dbg and pg == 1: print(f"  [DBG] Opinion pg1 empty list, breaking")
                    break
                for item in items:
                    if not isinstance(item, dict): continue
                    m_type = item.get("marketType", 0)
                    st = item.get("statusEnum", "")
                    if st not in ("Activated", "Active", ""): continue
                    if m_type == 0:
                        m = _parse_opinion_binary(item)
                        if m: markets.append(m)
                    elif m_type == 1:
                        cat_parents.append(item)
        except Exception as e:
            if dbg: print(f"  [DBG] Opinion pg{pg} error: {e}")
            continue

    if dbg:
        print(f"  [DBG] Opinion total: {len(markets)} binary + {len(cat_parents)} categorical parents")

    # Fetch categorical children (cached, refresh every CAT_REFRESH cycles)
    refresh_cats = (cycle == 1 or cycle % CAT_REFRESH == 0 or not _cat_cache)

    if refresh_cats and cat_parents:
        _cat_cache.clear()
        tasks = [_fetch_cat_children(session, p) for p in cat_parents]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for parent, result in zip(cat_parents, results):
            if isinstance(result, list):
                pid = parent.get("marketId", 0)
                _cat_cache[pid] = result

    # Add all cached children to markets
    bin_count = len(markets)
    cat_count = sum(len(c) for c in _cat_cache.values())
    for children in _cat_cache.values():
        markets.extend(children)

    _cat_ts = time.time()
    if cycle <= 3 or cycle % 50 == 0:
        print(f"  [OPINION] {len(markets)} total ({bin_count} binary + {cat_count} categorical from {len(_cat_cache)} parents)")
    return markets


async def _fetch_cat_children(session: aiohttp.ClientSession, parent: dict) -> List[Market]:
    """Fetch child markets for a categorical parent. (Pattern from dr-manhattan)"""
    pid = parent.get("marketId", 0)
    ptitle = parent.get("marketTitle", "") or parent.get("title", "")
    children = []

    try:
        url = f"{OP_BASE}/market/categorical/{pid}"
        async with session.get(url, headers=OP_HDR, timeout=aiohttp.ClientTimeout(total=8)) as r:
            if r.status != 200: return []
            data = await r.json()

        result = data.get("result", {}).get("data", data.get("result", {}))
        child_list = result.get("childMarkets", result.get("child_markets", []))

        for child in child_list:
            ctitle = child.get("marketTitle", "") or child.get("title", "")
            cid = child.get("marketId", "") or child.get("market_id", "")
            yt = str(child.get("yesTokenId", "") or child.get("yes_token_id", ""))
            nt = str(child.get("noTokenId", "") or child.get("no_token_id", ""))

            if not (ctitle and yt): continue

            # Build full title: parent context + child value
            full_title = _build_child_title(ptitle, ctitle)

            # Determine labels
            yl = child.get("yesLabel", "") or child.get("yes_label", "") or "YES"
            nl = child.get("noLabel", "") or child.get("no_label", "") or "NO"

            children.append(Market(
                id=str(cid), question=full_title,
                slug=f"op-child-{cid}",
                exchange="opinion",
                outcomes=[yl, nl],
                token_ids={yl: yt, nl: nt},
                prices={},  # fetched on demand
                market_type="child",
                parent_id=str(pid),
                parent_title=ptitle,
                metadata={"child_raw_title": ctitle},
            ))
    except Exception:
        pass

    return children


def _parse_opinion_binary(item: dict) -> Optional[Market]:
    """Parse a binary Opinion market.
    Enhanced with dr-manhattan _parse_market() patterns (lines 200-364):
    - Extract inline prices from listing (yesPrice/noPrice fields)
    - Capture volume24h for liquidity ranking
    - Handle multiple field name conventions
    """
    mid = str(item.get("marketId", "") or item.get("market_id", ""))
    title = item.get("marketTitle", "") or item.get("title", "") or item.get("question", "")
    if not (mid and title): return None

    yt = str(item.get("yesTokenId", "") or item.get("yes_token_id", "") or "")
    nt = str(item.get("noTokenId", "") or item.get("no_token_id", "") or "")
    if not yt: return None

    yl = item.get("yesLabel", "") or item.get("yes_label", "") or "Yes"
    nl = item.get("noLabel", "") or item.get("no_label", "") or "No"

    # Volume: prefer volume24h for recency, fallback to total volume
    vol = 0.0
    try: vol = float(item.get("volume24h", 0) or item.get("volume", 0) or 0)
    except: pass

    # Inline prices from listing (dr-manhattan pattern: avoid extra API call)
    prices = {}
    yp = _safe_float(item.get("yesPrice") or item.get("yes_price"))
    np_val = _safe_float(item.get("noPrice") or item.get("no_price"))
    if yp and 0 < yp < 1:
        prices[yl] = round(yp, 4)
        prices[nl] = round(np_val, 4) if np_val else round(1.0 - yp, 4)
    elif np_val and 0 < np_val < 1:
        prices[nl] = round(np_val, 4)
        prices[yl] = round(1.0 - np_val, 4)
    # Also check lastTradePrice / lastYesPrice / lastNoPrice
    elif _safe_float(item.get("lastYesPrice") or item.get("last_yes_price")):
        lyp = _safe_float(item.get("lastYesPrice") or item.get("last_yes_price"))
        prices[yl] = round(lyp, 4)
        prices[nl] = round(1.0 - lyp, 4)

    return Market(
        id=mid, question=title,
        slug=f"op-{mid}",
        exchange="opinion",
        outcomes=[yl, nl],
        token_ids={yl: yt, nl: nt},
        prices=prices,  # may have inline prices now!
        volume=vol,
        market_type="binary",
    )


def _build_child_title(parent: str, child: str) -> str:
    """Build a descriptive title for a categorical child market."""
    # If parent has "..." → replace with child value
    if "..." in parent:
        return parent.replace("...", child, 1)
    # If child is short (a value like "$430" or "Kevin Warsh") → append
    if len(child) < len(parent):
        return f"{parent} - {child}"
    # Otherwise use child title as-is (it's usually self-descriptive)
    return child


# ════════════════════════════════════════════════════════════════
# OPINION PRICE FETCHER
# ════════════════════════════════════════════════════════════════
_price_cache: Dict[str, Tuple[float, float]] = {}  # token -> (price, timestamp)

async def fetch_opinion_price(session: aiohttp.ClientSession,
                               yes_token: str, no_token: str) -> Tuple[Optional[float], Optional[float]]:
    """Fetch latest price for an Opinion market's YES token."""
    # Check cache
    cached = _price_cache.get(yes_token)
    if cached and (time.time() - cached[1]) < PRICE_TTL:
        return cached[0], round(1.0 - cached[0], 4)

    # Try latest-price endpoint first
    try:
        url = f"{OP_BASE}/token/latest-price"
        params = {"token_id": yes_token}
        async with session.get(url, headers=OP_HDR, params=params,
                               timeout=aiohttp.ClientTimeout(total=5)) as r:
            if r.status != 200: return await _fetch_price_from_book(session, yes_token)
            data = await r.json()
            if data.get("errno", data.get("code", -1)) != 0:
                return await _fetch_price_from_book(session, yes_token)
            price_val = data.get("result", {}).get("price")
            if price_val is not None:
                yp = round(float(price_val), 4)
                np = round(1.0 - yp, 4)
                _price_cache[yes_token] = (yp, time.time())
                return yp, np
            return await _fetch_price_from_book(session, yes_token)
    except Exception:
        return await _fetch_price_from_book(session, yes_token)


async def _fetch_price_from_book(session: aiohttp.ClientSession,
                                  token_id: str) -> Tuple[Optional[float], Optional[float]]:
    """Fetch price from orderbook (fallback)."""
    try:
        url = f"{OP_BASE}/token/orderbook"
        params = {"token_id": token_id}
        async with session.get(url, headers=OP_HDR, params=params,
                               timeout=aiohttp.ClientTimeout(total=5)) as r:
            if r.status != 200: return None, None
            data = await r.json()
            if data.get("errno", data.get("code", -1)) != 0: return None, None
            result = data.get("result", {})
            bids = result.get("bids", [])
            asks = result.get("asks", [])

            best_bid = float(bids[0]["price"]) if bids else 0.0
            best_ask = float(asks[0]["price"]) if asks else 0.0

            if best_bid > 0 and best_ask > 0:
                mid = round((best_bid + best_ask) / 2, 4)
            elif best_ask > 0:
                mid = round(best_ask, 4)
            elif best_bid > 0:
                mid = round(best_bid, 4)
            else:
                return None, None

            _price_cache[token_id] = (mid, time.time())
            return mid, round(1.0 - mid, 4)
    except Exception:
        return None, None


# ════════════════════════════════════════════════════════════════
# PAIRS DATABASE (curated matches)
# ════════════════════════════════════════════════════════════════
class PairsDB:
    def __init__(self):
        self.approved: Dict[str,dict] = {}
        self.rejected: Dict[str,dict] = {}
        self.pending:  Dict[str,dict] = {}
        self.load()

    @staticmethod
    def make_key(poly_slug: str, op_id: str) -> str:
        return f"{poly_slug}||{op_id}"

    def load(self):
        if os.path.exists(PAIRS_FILE):
            try:
                with open(PAIRS_FILE, encoding="utf-8") as f:
                    d = json.load(f)
                self.approved = d.get("approved", {})
                self.rejected = d.get("rejected", {})
                self.pending  = d.get("pending", {})
            except: pass

    def save(self):
        try:
            with open(PAIRS_FILE, "w", encoding="utf-8") as f:
                json.dump({"approved": self.approved, "rejected": self.rejected,
                           "pending": self.pending}, f, indent=2, ensure_ascii=True)
        except Exception as e:
            print(f"  DB save error: {e}")

    def status(self, key: str) -> str:
        if key in self.approved: return "approved"
        if key in self.rejected: return "rejected"
        if key in self.pending:  return "pending"
        return "new"

    def add_pending(self, key: str, poly_q: str, op_q: str, sim: float) -> bool:
        if key in self.approved or key in self.rejected or key in self.pending:
            return False
        self.pending[key] = {
            "poly_q": safe(poly_q), "op_q": safe(op_q),
            "sim": sim, "ts": time.time()
        }
        self.save()
        return True

    def approve(self, key: str) -> bool:
        if key in self.pending:
            self.approved[key] = self.pending.pop(key)
            self.approved[key]["approved_at"] = time.time()
            self.save()
            return True
        return False

    def reject(self, key: str, reason: str = "manual") -> Optional[dict]:
        if key in self.pending:
            self.rejected[key] = self.pending.pop(key)
            self.rejected[key]["reason"] = reason
            self.rejected[key]["rejected_at"] = time.time()
            self.save()
            return self.rejected[key]
        return None

    def stats(self) -> Tuple[int,int,int]:
        return len(self.approved), len(self.rejected), len(self.pending)


# ════════════════════════════════════════════════════════════════
# PATTERN LEARNER
# ════════════════════════════════════════════════════════════════
class PatternLearner:
    def __init__(self):
        self.rules: List[dict] = []
        self.load()

    def load(self):
        if os.path.exists(PATTERNS_FILE):
            try:
                with open(PATTERNS_FILE, encoding="utf-8") as f:
                    self.rules = json.load(f)
            except: pass

    def save(self):
        try:
            with open(PATTERNS_FILE, "w", encoding="utf-8") as f:
                json.dump(self.rules, f, indent=2, ensure_ascii=True)
        except: pass

    def learn(self, poly_q: str, op_q: str, reason: str) -> List[dict]:
        """Extract patterns from a rejected pair."""
        p, o = poly_q.lower(), op_q.lower()
        patterns = []

        # Different person names
        pn = _extract_names(p)
        on = _extract_names(o)
        if pn and on and not (pn & on):
            patterns.append({"type": "diff_person", "p": list(pn), "o": list(on)})

        # Different deadline month
        pm = _extract_month(p)
        om = _extract_month(o)
        if pm and om and pm != om:
            patterns.append({"type": "diff_deadline", "p": pm, "o": om})

        # Different action/event
        pa = _extract_action(p)
        oa = _extract_action(o)
        if pa and oa and pa != oa:
            patterns.append({"type": "diff_action", "p": pa, "o": oa})

        # Different specific item
        pi = _extract_item(p)
        oi = _extract_item(o)
        if pi and oi and pi != oi:
            patterns.append({"type": "diff_item", "p": pi, "o": oi})

        if patterns:
            self.rules.extend(patterns)
            self.save()
        return patterns

    def should_reject(self, poly_q: str, op_q: str) -> Tuple[bool, str]:
        """Check if a pair matches any learned rejection pattern."""
        p, o = poly_q.lower(), op_q.lower()
        pn, on = _extract_names(p), _extract_names(o)
        pm, om = _extract_month(p), _extract_month(o)
        pa, oa = _extract_action(p), _extract_action(o)
        pi, oi = _extract_item(p), _extract_item(o)

        for rule in self.rules:
            rt = rule["type"]
            if rt == "diff_person" and pn and on and not (pn & on):
                return True, "learned:diff_person"
            if rt == "diff_deadline" and pm and om and pm != om:
                return True, "learned:diff_deadline"
            if rt == "diff_action" and pa and oa and pa != oa:
                return True, "learned:diff_action"
            if rt == "diff_item" and pi and oi and pi != oi:
                return True, "learned:diff_item"
        return False, ""


# Helper extractors for pattern learning
_NAMES_RE = re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b')
_MONTH_MAP = {"jan":"jan","feb":"feb","mar":"mar","apr":"apr","may":"may","jun":"jun",
              "jul":"jul","aug":"aug","sep":"sep","oct":"oct","nov":"nov","dec":"dec",
              "january":"jan","february":"feb","march":"mar","april":"apr",
              "june":"jun","july":"jul","august":"aug","september":"sep",
              "october":"oct","november":"nov","december":"dec"}

def _extract_names(t: str) -> set:
    # Look for "- Name" pattern in child markets
    m = re.search(r'-\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)', t, re.IGNORECASE)
    if m: return {m.group(1).strip().lower()}
    # General proper names
    found = _NAMES_RE.findall(t.upper() if t else "")
    return {n.lower() for n in found}

def _extract_month(t: str) -> str:
    for word in t.split():
        w = word.strip(".,?!:;").lower()
        if w in _MONTH_MAP: return _MONTH_MAP[w]
    return ""

def _extract_action(t: str) -> str:
    actions = [("strike","strike"),("ceasefire","ceasefire"),("invade","invade"),
               ("meeting","meeting"),("nominate","nominate"),("deport","deport"),
               ("tariff","tariff"),("regime fall","regime_fall"),("sentenced","sentence"),
               ("acquire","acquire"),("release","release"),("launch","launch"),
               ("ipo","ipo"),("close above","close_above"),("reach","reach"),
               ("hit","hit"),("win","win"),("best picture","best_picture"),
               ("best director","best_director"),("champion","champion")]
    for phrase, act in actions:
        if phrase in t: return act
    return ""

def _extract_item(t: str) -> str:
    # Pokemon cards
    for card in ["illustrator","charizard","pikachu","blastoise"]:
        if card in t: return card
    # After "- " in child markets
    m = re.search(r'-\s*(.+?)(?:\?|$)', t)
    if m: return m.group(1).strip().lower()[:30]
    return ""


# ════════════════════════════════════════════════════════════════
# LLM VALIDATOR — Uses OpenRouter to validate market pairs
# ════════════════════════════════════════════════════════════════
def _parse_narrative_response(text: str, expected: int) -> Optional[List[bool]]:
    """Parse TRUE/FALSE verdicts from narrative LLM response."""
    text_lower = text.lower()
    results = []

    # Look for numbered items with true/false
    for i in range(1, expected + 1):
        # Find the section for this pair number
        pattern = rf'(?:^|\n)\s*{i}[\.\):]'
        m = re.search(pattern, text)
        if m:
            # Get text after the number until next number or end
            start = m.end()
            next_pattern = rf'(?:^|\n)\s*{i+1}[\.\):]'
            m2 = re.search(next_pattern, text[start:])
            section = text[start:start + m2.start()] if m2 else text[start:]
            section_lower = section.lower()

            if "true" in section_lower and "false" not in section_lower:
                results.append(True)
            elif "false" in section_lower:
                results.append(False)
            elif "same" in section_lower and "not" not in section_lower and "different" not in section_lower:
                results.append(True)
            elif "different" in section_lower or "not the same" in section_lower:
                results.append(False)
            else:
                results.append(False)  # Default to False (safer)
        else:
            results.append(False)

    return results if len(results) == expected else None


async def llm_validate_batch(session: aiohttp.ClientSession,
                              pairs: List[Tuple[str, str, str, Market, Market]]) -> Dict[str, bool]:
    """
    Validate market pairs using LLM via OpenRouter.
    pairs: [(key, poly_question, opinion_question, poly_market, op_market), ...]
    Returns: {key: True/False} where True = same market, False = different
    """
    if not LLM_KEY or not pairs:
        return {}

    # Build enriched batch prompt with outcomes/labels
    lines = []
    for i, (key, pq, oq, pm, om) in enumerate(pairs):
        p_outcomes = "/".join(pm.outcomes) if pm else "Yes/No"
        o_outcomes = "/".join(om.outcomes) if om else "Yes/No"
        p_prices = f" @ {pm.yes_price:.2f}/{pm.no_price:.2f}" if pm and pm.has_prices else ""
        o_prices = f" @ {om.yes_price:.2f}/{om.no_price:.2f}" if om and om.has_prices else ""
        lines.append(f"{i+1}. P: {pq} (Outcomes: {p_outcomes}{p_prices})")
        lines.append(f"   O: {oq} (Outcomes: {o_outcomes}{o_prices})")

    prompt = f"""Task: For each pair, determine if both markets refer to the IDENTICAL real-world outcome. 
If someone buys YES on P and YES on O, do they profit from the SAME event? Output true/false.

TRUE if:
- Same team/person + same competition + same outcome (e.g. "Dallas Stars win Stanley Cup" vs "Stanley Cup Champion - Dallas Stars")
- Same event with slightly different wording
- "by end of 2025" vs "by December 31, 2025" (same deadline)
- "Zelenskyy out by end of 2025" vs "Zelenskyy out by June 2026" (shorter implies longer)
- "GDP growth in 2025" vs "GDP Growth in Q3 2025" (Q3 is part of 2025)

FALSE if:
- Different team/person even in same competition (Benfica win UCL ≠ PSG win UCL)
- Different price target ($2B vs $6B)
- Different event type (Champion vs MVP)
- Unrelated topics

IMPORTANT: Focus on whether the SAME specific entity wins/achieves the SAME specific outcome.
"Team X win League" on Polymarket vs "League Winner - Team X" on Opinion = TRUE (same team!)
"Team X win League" on Polymarket vs "League Winner - Team Y" on Opinion = FALSE (different team!)

{len(pairs)} pairs:

{chr(10).join(lines)}

OUTPUT ONLY a JSON array of {len(pairs)} booleans. Example: [true, false, true]"""

    try:
        headers = {
            "Authorization": f"Bearer {LLM_KEY}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/prophetlabs",
        }
        body = {
            "model": LLM_MODEL,
            "messages": [
                {"role": "system", "content": "You are a strict prediction market validator. Output ONLY a valid JSON array of booleans. No explanation, no reasoning, no markdown code blocks. Just the raw array like [true,false,true]."},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 300,
            "temperature": 0.0,
        }
        async with session.post(LLM_URL, headers=headers, json=body,
                                timeout=aiohttp.ClientTimeout(total=60)) as r:
            if r.status != 200:
                err = await r.text()
                print(f"  [LLM] Error {r.status}: {err[:100]}")
                return {}
            data = await r.json()

        # Debug: show raw response structure on first call
        choices = data.get("choices", [])
        if not choices:
            print(f"  [LLM] No choices in response. Keys: {list(data.keys())}")
            if "error" in data:
                print(f"  [LLM] Error: {data['error']}")
            return {}

        msg = choices[0].get("message", {})
        content = msg.get("content", "")

        # MiniMax may put response in reasoning field
        if not content and "reasoning" in msg:
            content = msg.get("reasoning", "")
        if not content and "reasoning_content" in msg:
            content = msg.get("reasoning_content", "")

        # Also check for tool calls or other formats
        if not content:
            print(f"  [LLM] Empty content. Message keys: {list(msg.keys())}")
            print(f"  [LLM] Full message: {json.dumps(msg, ensure_ascii=True)[:300]}")
            return {}

        # Parse JSON array from response — robust extraction
        content = content.strip()
        # Remove markdown code blocks
        if "```" in content:
            import re as _re
            m = _re.search(r'```(?:json)?\s*\n?(.*?)\n?```', content, _re.DOTALL)
            if m: content = m.group(1).strip()
        # Find the JSON array anywhere in the text
        bracket_start = content.find("[")
        bracket_end = content.rfind("]")
        if bracket_start == -1 or bracket_end == -1:
            # Fallback: try to extract true/false from narrative text
            results = _parse_narrative_response(content, len(pairs))
            if results:
                print(f"  [LLM] Parsed narrative response")
            else:
                print(f"  [LLM] Could not parse response: {safe(content[:200])}")
                return {}
        else:
            json_str = content[bracket_start:bracket_end+1]
            results = json.loads(json_str)

        if not isinstance(results, list):
            print(f"  [LLM] Not a list: {type(results)}")
            return {}

        # Adjust length if needed
        if len(results) != len(pairs):
            print(f"  [LLM] Length mismatch: got {len(results)}, expected {len(pairs)}")
            if len(results) > len(pairs):
                results = results[:len(pairs)]
            elif len(results) < len(pairs):
                results = results + [False] * (len(pairs) - len(results))

        verdicts = {}
        for pair_tuple, verdict in zip(pairs, results):
            key = pair_tuple[0]
            verdicts[key] = bool(verdict)

        ok = sum(1 for v in verdicts.values() if v)
        rej = sum(1 for v in verdicts.values() if not v)
        print(f"  [LLM] Validated {len(pairs)} pairs: {ok} approved, {rej} rejected")
        return verdicts

    except json.JSONDecodeError as e:
        print(f"  [LLM] JSON parse error: {e}")
        return {}
    except Exception as e:
        import traceback
        print(f"  [LLM] Error: {type(e).__name__}: {e}")
        traceback.print_exc()
        return {}


# ════════════════════════════════════════════════════════════════
# MATCHING ENGINE
# ════════════════════════════════════════════════════════════════

# ── Field Extraction (from v12) ──
def extract_target(title: str) -> str:
    t = title.lower()
    m = re.search(r'\$[\d,]+(?:\.\d+)?(?:[kmbt])?', t)
    if m: return m.group().replace(",", "")
    m = re.search(r'\b(\d{3,})\b', t)
    if m: return m.group()
    return ""

def extract_deadline(title: str) -> str:
    t = title.lower()
    months = {"january":"jan","jan":"jan","february":"feb","feb":"feb",
              "march":"mar","mar":"mar","april":"apr","apr":"apr",
              "may":"may","june":"jun","jun":"jun","july":"jul","jul":"jul",
              "august":"aug","aug":"aug","september":"sep","sep":"sep",
              "october":"oct","oct":"oct","november":"nov","nov":"nov",
              "december":"dec","dec":"dec"}
    for full, short in months.items():
        dm = re.search(rf'{full}\.?\s*(\d{{1,2}})', t)
        if dm: return f"{short}_{dm.group(1)}"
    m = re.search(r'end of (\w+)', t)
    if m:
        for full, short in months.items():
            if m.group(1).lower().startswith(full[:3]):
                return f"{short}_end"
    for month_name, short in [("february","feb"),("march","mar"),("january","jan"),
                               ("april","apr"),("june","jun"),("july","jul"),
                               ("may","may"),("august","aug")]:
        if f"in {month_name}" in t or f"of {month_name}" in t: return short
    m = re.search(r'(?:in|before|by)\s*(20\d{2})', t)
    if m: return f"y{m.group(1)}"
    hm = re.search(r'(\d{2}:\d{2})\s*utc', t)
    if hm: return f"hourly_{hm.group(1)}"
    return ""

def extract_event(title: str) -> str:
    t = title.lower()
    if "up or down" in t: return "updown"
    if "close above" in t or "close at" in t: return "close_above"
    if "settle" in t and ("above" in t or "over" in t): return "close_above"
    if re.search(r'(?:reach|hit)\s', t): return "reach"
    if "above" in t and "$" in t: return "above_price"
    if "all time high" in t: return "ath"
    if "win " in t or "champion" in t or "winner" in t:
        if "all-star" in t or "all star" in t: return "allstar"
        if "mvp" in t and ("all-star" in t or "all star" in t): return "allstar"
        if "mvp" in t: return "mvp"
        if "defensive player" in t or "dpoy" in t: return "dpoy"
        if "rookie" in t or "roy" in t: return "roy"
        if "eastern" in t: return "win_east"
        if "western" in t: return "win_west"
        if "stanley cup" in t: return "win_cup"
        if "playoff" in t: return "playoff"
        return "win"
    if "playoff" in t or "make the" in t: return "playoff"
    if "defensive player" in t or "dpoy" in t: return "dpoy"
    if "mvp" in t: return "mvp"
    if "rookie" in t and "year" in t: return "roy"
    if "fdv" in t or "market cap" in t: return "valuation"
    if "ipo" in t: return "ipo"
    if "launch" in t: return "launch"
    if "release" in t: return "release"
    if "strike" in t or "attack" in t: return "military"
    if "out as" in t or "impeach" in t: return "removal"
    if "move" in t and "bitcoin" in t: return "satoshi_move"
    if "acquire" in t: return "acquisition"
    if " vs " in t: return "match"
    if "nominate" in t: return "nominate"
    if "what price" in t or "what will" in t: return "price_range"
    return "generic"

def extract_fields(title: str) -> dict:
    return {"s": extract_subject(title), "e": extract_event(title),
            "t": extract_target(title), "d": extract_deadline(title)}

def compatible(f1: dict, f2: dict) -> bool:
    """Check if two markets are structurally compatible (same subject, event, target, deadline)."""
    if f1["s"] != f2["s"]: return False

    # NEVER match two "unknown" or fallback subjects
    if f1["s"] == "unknown" or "_" in f1["s"] and len(f1["s"]) > 20:
        return False

    e1, e2 = f1["e"], f2["e"]
    compat_pairs = {
        ("close_above","close_above"), ("close_above","above_price"),
        ("close_above","reach"), ("reach","above_price"),
        ("reach","reach"), ("above_price","above_price"),
        ("updown","updown"), ("win","win"),
        ("win_east","win_east"), ("win_west","win_west"),
        ("win_cup","win_cup"), ("allstar","allstar"),
        ("mvp","mvp"), ("dpoy","dpoy"), ("roy","roy"), ("playoff","playoff"),
        ("valuation","valuation"),
        ("ipo","ipo"), ("ipo","valuation"),
        ("launch","launch"), ("release","release"),
        ("military","military"), ("removal","removal"),
        ("satoshi_move","satoshi_move"), ("acquisition","acquisition"),
        ("match","match"), ("nominate","nominate"),
        ("ath","ath"),
        ("price_range","reach"), ("price_range","above_price"),
        ("price_range","close_above"),
    }

    # generic+generic only allowed if BOTH subjects are specific (not fallback words)
    if e1 == "generic" and e2 == "generic":
        # Only allow if subject is a well-known entity (not word-based fallback)
        known_subjects = {
            "bitcoin","ethereum","solana","bnb","btc_updown","eth_updown","bnb_updown",
            "tsla","nvda","googl","amzn","aapl","msft","silver","gold","spx",
            "trump","biden","zelenskyy","khamenei","israel","iran","ukraine","russia",
            "nba","nhl","nfl","laliga","epl","f1","ncaa","oscars",
            "gta6","openai","pope","spacex","discord","satoshi","greenland",
            "logan_paul","nflx","puffpaw","megaeth","yoon","fed","fed_chair",
            "pm_leader","monad","berachain","gdp","jesus",
            "superbowl","ucl","world_cup","ufc","tiktok",
            "doge","xrp","ada","ath_crypto","real_madrid",
            # New subjects
            "cerebras","hyperliquid","perena","binance","coinbase","kraken",
            "robinhood","stripe","pltr","meta","anthropic","midjourney",
            "usdt","usdc","sui","avax","dot","link","uni","aave","jup",
            "starlink","neuralink","shib","pepe","bonk",
            "waymo","figma","databricks","canva","klarna","revolut",
            "reddit","snap","tariff","nato","ceasefire","gaza",
            "taiwan","china","korea","japan","india","brazil_country",
            "canada","mexico","immigration","deport","impeach",
            "assassination","pandemic","bird_flu",
            "ipo_event","token_launch","israel_iran",
            "binance_listing","coinbase_listing",
        }
        if f1["s"] not in known_subjects:
            return False

    if e1 != e2 and (e1,e2) not in compat_pairs and (e2,e1) not in compat_pairs:
        return False
    # Target check: strict for price events, relaxed for win/valuation (LLM decides)
    if f1["t"] and f2["t"] and f1["t"] != f2["t"]:
        # Allow through for win/valuation — different targets are different teams/values
        # but we want the LLM to see them and decide
        relaxed_events = {"win","win_east","win_west","win_cup","playoff",
                          "valuation","generic","allstar","mvp","dpoy","roy"}
        if e1 not in relaxed_events and e2 not in relaxed_events:
            return False
    d1, d2 = f1["d"], f2["d"]
    if d1 and d2:
        b1, b2 = d1.split("_")[0], d2.split("_")[0]
        if b1 != b2:
            if not (d1.startswith("y") and d2.startswith("y") and d1 == d2):
                return False
    return True
def extract_subject(title: str) -> str:
    """Extract canonical subject from market title."""
    t = title.lower()
    # Check for stock tickers in parentheses first
    m = re.search(r'\(([A-Z]{1,5})\)', title)
    if m: return m.group(1).lower()

    # Specific multi-word phrases first (order matters!)
    PHRASE_SUBJECTS = [
        ("bitcoin up or down","btc_updown"),("btc up or down","btc_updown"),
        ("ethereum up or down","eth_updown"),("eth up or down","eth_updown"),
        ("bnb up or down","bnb_updown"),
        ("prime minister","pm_leader"),("bontenbal","pm_leader"),
        ("fed rate","fed"),("fed chair","fed_chair"),
        ("rate cut","fed"),("rate decision","fed"),
        ("s&p 500","spx"),("sp500","spx"),
        ("la liga","laliga"),("premier league","epl"),
        ("formula 1","f1"),("champions league","ucl"),
        ("super bowl","superbowl"),("world cup","world_cup"),
        ("logan paul","logan_paul"),("real madrid","real_madrid"),
        ("academy awards","oscars"),("all time high","ath_crypto"),
        ("gta vi","gta6"),("gta 6","gta6"),("tik tok","tiktok"),
        ("bird flu","bird_flu"),
        ("cerebras ipo","cerebras"),("cerebras","cerebras"),
        ("hyperliquid listed","hyperliquid"),("hyperliquid","hyperliquid"),
        ("perena launch","perena"),("perena","perena"),
        ("listed on binance","binance_listing"),
        ("binance listing","binance_listing"),("coinbase listing","coinbase_listing"),
        ("ipo before","ipo_event"),("go public","ipo_event"),
        ("launch a token","token_launch"),("token launch","token_launch"),
        ("strikes iran","israel_iran"),("strike iran","israel_iran"),
        ("us/israel","israel_iran"),("israel strike","israel_iran"),
    ]
    for phrase, subj in PHRASE_SUBJECTS:
        if phrase in t: return subj

    # Single word subjects — must match as WHOLE WORD to avoid substring issues
    WORD_SUBJECTS = [
        ("bitcoin","bitcoin"),("btc","bitcoin"),
        ("ethereum","ethereum"),("solana","solana"),("bnb","bnb"),
        ("silver","silver"),("gold","gold"),
        ("tesla","tsla"),("nvidia","nvda"),
        ("google","googl"),("amazon","amzn"),
        ("apple","aapl"),("microsoft","msft"),
        ("spacex","spacex"),("discord","discord"),
        ("spx","spx"),
        ("trump","trump"),("biden","biden"),
        ("zelenskyy","zelenskyy"),("zelensky","zelenskyy"),
        ("khamenei","khamenei"),
        ("israel","israel"),("iran","iran"),
        ("ukraine","ukraine"),("russia","russia"),
        ("nba","nba"),("nhl","nhl"),("nfl","nfl"),
        ("ncaa","ncaa"),("oscars","oscars"),
        ("openai","openai"),("pope","pope"),
        ("netflix","nflx"),("tiktok","tiktok"),
        ("yoon","yoon"),("satoshi","satoshi"),
        ("greenland","greenland"),
        ("puffpaw","puffpaw"),("megaeth","megaeth"),
        ("monad","monad"),("berachain","berachain"),
        ("gdp","gdp"),("recession","gdp"),
        ("jesus","jesus"),("christ","jesus"),
        ("superbowl","superbowl"),
        ("ufc","ufc"),("mma","ufc"),
        ("doge","doge"),("dogecoin","doge"),
        ("xrp","xrp"),("ripple","xrp"),
        ("cardano","ada"),
        ("netherlands","pm_leader"),("dutch","pm_leader"),
        # Missing subjects from competitor dashboards
        ("cerebras","cerebras"),("hyperliquid","hyperliquid"),
        ("perena","perena"),("binance","binance"),
        ("coinbase","coinbase"),("kraken","kraken"),
        ("robinhood","robinhood"),("stripe","stripe"),
        ("palantir","pltr"),("meta","meta"),
        ("anthropic","anthropic"),("midjourney","midjourney"),
        ("tether","usdt"),("usdc","usdc"),
        ("sui","sui"),("avax","avax"),("polkadot","dot"),
        ("chainlink","link"),("uniswap","uni"),
        ("aave","aave"),("jupiter","jup"),
        ("starlink","starlink"),("neuralink","neuralink"),
        ("shiba","shib"),("pepe","pepe"),("bonk","bonk"),
        ("waymo","waymo"),("figma","figma"),
        ("databricks","databricks"),("canva","canva"),
        ("klarna","klarna"),("revolut","revolut"),
        ("reddit","reddit"),("snap","snap"),
        ("tariff","tariff"),("nato","nato"),
        ("ceasefire","ceasefire"),("gaza","gaza"),
        ("taiwan","taiwan"),("china","china"),
        ("korea","korea"),("japan","japan"),
        ("india","india"),("brazil","brazil_country"),
        ("canada","canada"),("mexico","mexico"),
        ("immigration","immigration"),("deport","deport"),
        ("impeach","impeach"),("assassination","assassination"),
        ("pandemic","pandemic"),("bird flu","bird_flu"),
        ("earthquake","earthquake"),("hurricane","hurricane"),
    ]
    for word, subj in WORD_SUBJECTS:
        # Word boundary match to avoid "bontenbal" matching "nba"
        if re.search(rf'\b{re.escape(word)}\b', t):
            return subj

    # Check for "eth" separately (short, needs word boundary)
    if re.search(r'\beth\b', t): return "ethereum"
    if re.search(r'\bf1\b', t): return "f1"
    if re.search(r'\bada\b', t): return "ada"

    # Fallback: significant words
    words = [w for w in re.findall(r'[a-z]+', t) if len(w)>3
             and w not in {"will","the","what","which","does","have","been","this",
                           "that","before","after","above","below","price","february",
                           "march","april","june","july","2025","2026","2027"}]
    return "_".join(words[:3]) if words else "unknown"


def norm(t: str) -> str:
    """Normalize title for comparison."""
    t = t.lower().strip()
    t = re.sub(r'\([^)]*\)', '', t)         # remove (ticker)
    t = re.sub(r'[^\w\s$%.]', ' ', t)       # keep $, %, .
    return re.sub(r'\s+', ' ', t).strip()


def compute_similarity(poly: Market, op: Market) -> float:
    """Compute text similarity between two markets.
    Uses both sequence similarity and word overlap for better matching.
    """
    pn = norm(poly.question)
    on = norm(op.question)
    # Sequence similarity (full text, not truncated)
    seq_sim = SequenceMatcher(None, pn, on).ratio()
    # Word overlap (Jaccard)
    pw = set(pn.split()) - {"will", "the", "in", "a", "of", "to", "and", "or", "be", "by", "on", "at", "for"}
    ow = set(on.split()) - {"will", "the", "in", "a", "of", "to", "and", "or", "be", "by", "on", "at", "for"}
    if pw and ow:
        jaccard = len(pw & ow) / len(pw | ow)
    else:
        jaccard = 0.0
    # Weighted: 60% sequence, 40% word overlap
    return seq_sim * 0.6 + jaccard * 0.4


def subjects_match(poly: Market, op: Market) -> bool:
    """Fast gate: do subjects match?"""
    return extract_subject(poly.question) == extract_subject(op.question)


def _subjects_related(s1: str, s2: str) -> bool:
    """Check if two subjects are semantically related (broader than exact match).
    e.g. 'nhl' and 'nhl' → True
         'nba' and 'nba' → True
         'ucl' and 'ucl' → True
         'nhl' and 'nba' → False
    Also handles cases where one is generic or a category.
    """
    if s1 == s2: return True
    # Sports leagues share same sport categories
    RELATED = {
        frozenset({"ucl", "laliga", "epl"}),  # European football
        frozenset({"bitcoin", "btc_updown"}),
        frozenset({"ethereum", "eth_updown"}),
        frozenset({"bnb", "bnb_updown"}),
        frozenset({"ipo_event", "cerebras", "stripe", "databricks", "klarna"}),
    }
    pair = frozenset({s1, s2})
    for group in RELATED:
        if s1 in group and s2 in group:
            return True
    return False


def _extract_team_or_entity(title: str) -> str:
    """Extract the specific team/person/entity from a market title.
    For categorical: 'NBA Champion - Dallas Stars' → 'dallas stars'
    For binary: 'Will the Dallas Stars win the 2026 NHL' → 'dallas stars'
    """
    t = title.lower()
    # Categorical pattern: "Competition Winner - Team Name"
    m = re.search(r'(?:champion|winner|mvp|roy|dpoy)(?:\s+\d{4})?\s*[-–—:]\s*(.+?)$', t)
    if m:
        return re.sub(r'[^\w\s]', '', m.group(1)).strip()
    # Binary pattern: "Will the TEAM win the ..."
    m = re.search(r'will (?:the )?(.+?)\s+(?:win|make|reach|finish|qualify)', t)
    if m:
        team = m.group(1).strip()
        team = re.sub(r'^(a |an |the )', '', team)
        return re.sub(r'[^\w\s]', '', team).strip()
    # Binary pattern: "Will PERSON become/be/get ..."
    m = re.search(r'will\s+(.+?)\s+(?:become|be |get |have |remain)', t)
    if m:
        return re.sub(r'[^\w\s]', '', m.group(1)).strip()
    return ""


def rule_match(pm: Market, om: Market) -> Optional[bool]:
    """Deterministic matching for obvious cases. Returns:
    True  = definitely same market (auto-approve)
    False = definitely different (auto-reject)
    None  = ambiguous (send to LLM)
    """
    pq, oq = pm.question.lower(), om.question.lower()
    pn, on = norm(pm.question), norm(om.question)

    # ── Exact or near-exact text match → TRUE ──
    sim = SequenceMatcher(None, pn, on).ratio()
    if sim >= 0.85:
        return True

    # ── Extract entities and compare ──
    pe = _extract_team_or_entity(pm.question)
    oe = _extract_team_or_entity(om.question)

    if pe and oe:
        # Both have extractable entities
        if pe == oe:
            # Same entity — check if same competition/event type
            ps = extract_subject(pm.question)
            os_ = extract_subject(om.question)
            if ps == os_:
                return True  # Same entity + same subject → auto-approve
            # Different subjects but same entity is ambiguous
            return None
        else:
            # Different entities — check same subject (means cross-entity comparison)
            ps = extract_subject(pm.question)
            os_ = extract_subject(om.question)
            if ps == os_:
                return False  # Same competition but DIFFERENT team → auto-reject

    # ── Completely unrelated topics → FALSE ──
    ps = extract_subject(pm.question)
    os_ = extract_subject(om.question)
    if ps and os_ and ps != os_:
        # Different known subjects → almost certainly different markets
        known = {"bitcoin","ethereum","solana","bnb","trump","biden","nba","nhl","nfl",
                 "laliga","epl","ucl","openai","pope","spacex","tsla","nvda","fed",
                 "zelenskyy","israel","iran","ukraine","russia","tiktok"}
        if ps in known or os_ in known:
            return False  # One side is a well-known specific topic → reject cross-topic
        # For unknown subjects, check word overlap
        pw = set(pn.split())
        ow = set(on.split())
        overlap = pw & ow - {"will", "the", "in", "a", "of", "to", "and", "or", "be", "by",
                              "on", "at", "for", "is", "it", "2025", "2026", "before", "after",
                              "end", "december", "january", "march", "june"}
        if len(overlap) < 2:
            return False  # Almost no content word overlap → reject

    return None  # Ambiguous → LLM


def discover_candidates(poly_markets: List[Market], op_markets: List[Market],
                        db: PairsDB, learner: PatternLearner) -> List[Tuple[Market, Market, float, str]]:
    """Find candidate pairs for curation.
    Strategy: three-pass approach
      Pass 1: compatible() filter (strict subject match) — fast
      Pass 2: entity-based matching (extract team/person and compare) — medium
      Pass 3: text similarity fallback for markets not matched — slow
    """
    candidates = []
    matched_op_ids = set()
    matched_keys = set()  # avoid duplicates across passes

    # Pre-compute fields for all markets
    op_fields = [(om, extract_fields(om.question)) for om in op_markets if om.yes_token]
    poly_fields = [(pm, extract_fields(pm.question)) for pm in poly_markets]

    # ── Pass 1: subject-based matching (fast, high precision) ──
    p1_compat = 0
    for om, of in op_fields:
        best_sim, best_pm = 0.0, None
        for pm, pf in poly_fields:
            if not compatible(pf, of): continue
            p1_compat += 1
            sim = compute_similarity(pm, om)
            if sim > best_sim:
                best_sim = sim
                best_pm = pm

        if best_pm and best_sim >= 0.12:
            key = PairsDB.make_key(best_pm.slug, om.id)
            status = db.status(key)
            if status == "rejected": continue
            if status == "new":
                reject, reason = learner.should_reject(best_pm.question, om.question)
                if reject:
                    db.add_pending(key, best_pm.question, om.question, best_sim)
                    db.reject(key, reason=reason)
                    continue
            candidates.append((best_pm, om, min(best_sim, 1.0), status))
            matched_op_ids.add(om.id)
            matched_keys.add(key)

    # ── Pass 2: entity-based matching (team/person extraction) ──
    # For Opinion markets not matched in pass 1, compare extracted entities
    unmatched_op_2 = [(om, of) for om, of in op_fields if om.id not in matched_op_ids]
    p2_found = 0

    if unmatched_op_2:
        # Pre-extract entities for all Poly markets
        poly_entities = [(pm, _extract_team_or_entity(pm.question), extract_subject(pm.question))
                         for pm in poly_markets]

        for om, of in unmatched_op_2:
            oe = _extract_team_or_entity(om.question)
            os_ = extract_subject(om.question)
            if not oe or len(oe) < 3: continue

            best_sim, best_pm = 0.0, None
            for pm, pe, ps in poly_entities:
                if not pe: continue
                # Same entity + same or related subject
                if pe == oe and (ps == os_ or _subjects_related(ps, os_)):
                    sim = compute_similarity(pm, om)
                    if sim > best_sim:
                        best_sim = sim
                        best_pm = pm

            if best_pm and best_sim >= 0.10:
                key = PairsDB.make_key(best_pm.slug, om.id)
                if key in matched_keys: continue
                status = db.status(key)
                if status == "rejected": continue
                if status == "new":
                    reject, reason = learner.should_reject(best_pm.question, om.question)
                    if reject:
                        db.add_pending(key, best_pm.question, om.question, best_sim)
                        db.reject(key, reason=reason)
                        continue
                candidates.append((best_pm, om, min(best_sim, 1.0), status))
                matched_op_ids.add(om.id)
                matched_keys.add(key)
                p2_found += 1

    # ── Pass 3: text similarity fallback (catches mismatched subjects) ──
    # IMPORTANT: require content word overlap to avoid structural-only matches
    # (e.g. "Trump resign by Dec 2025" ↔ "Bitcoin $150k by Dec 2025" both match structurally)
    STOP_WORDS = {"will", "the", "in", "a", "of", "to", "and", "or", "be", "by", "on", "at",
                  "for", "is", "it", "an", "this", "that", "not", "if", "before", "after",
                  "more", "than", "end", "2024", "2025", "2026", "2027", "2028",
                  "december", "january", "february", "march", "april", "may", "june",
                  "july", "august", "september", "october", "november",
                  "yes", "no", "what", "who", "how", "when", "where", "which",
                  "has", "have", "had", "do", "does", "did", "can", "could", "would", "should",
                  "from", "with", "about", "into", "during", "between",
                  "new", "first", "last", "next", "any", "each", "every",
                  "over", "under", "above", "below", "up", "down",
                  "00", "000", "31"}
    unmatched_op_3 = [om for om, _ in op_fields if om.id not in matched_op_ids]
    p3_found = 0

    if unmatched_op_3:
        poly_norms = [(pm, norm(pm.question), set(norm(pm.question).split()) - STOP_WORDS)
                       for pm in poly_markets]

        for om in unmatched_op_3:
            on = norm(om.question)
            ow = set(on.split()) - STOP_WORDS
            if not ow: continue

            best_sim, best_pm, best_overlap = 0.0, None, 0

            for pm, pn, pw in poly_norms:
                # Require at least 2 meaningful content words in common
                overlap = pw & ow
                if len(overlap) < 2: continue

                sim = SequenceMatcher(None, pn, on).ratio()
                # Weight by word overlap: more shared words = higher effective sim
                effective_sim = sim * 0.6 + (len(overlap) / max(len(pw | ow), 1)) * 0.4
                if effective_sim > best_sim:
                    best_sim = effective_sim
                    best_pm = pm
                    best_overlap = len(overlap)

            if best_pm and best_sim >= 0.35 and best_overlap >= 2:
                key = PairsDB.make_key(best_pm.slug, om.id)
                if key in matched_keys: continue
                status = db.status(key)
                if status == "rejected": continue
                if status == "new":
                    reject, reason = learner.should_reject(best_pm.question, om.question)
                    if reject:
                        db.add_pending(key, best_pm.question, om.question, best_sim)
                        db.reject(key, reason=reason)
                        continue
                candidates.append((best_pm, om, min(best_sim, 1.0), status))
                matched_keys.add(key)
                p3_found += 1

    # Diagnostic logging
    total_op = len(op_fields)
    print(f"  [MATCH] {total_op} OP markets | P1:{len(candidates)-p2_found-p3_found} compat({p1_compat} pairs tested) | P2:{p2_found} entity | P3:{p3_found} text | Total:{len(candidates)}")

    candidates.sort(key=lambda x: x[2], reverse=True)
    return candidates


def monitor_approved(poly_markets: List[Market], op_markets: List[Market],
                     db: PairsDB) -> List[Tuple[Market, Market, float]]:
    """Fast: only return approved pairs."""
    approved_keys = set(db.approved.keys())
    if not approved_keys: return []

    poly_by_slug = {m.slug: m for m in poly_markets}
    op_by_id = {m.id: m for m in op_markets}

    matches = []
    for key in approved_keys:
        parts = key.split("||")
        if len(parts) != 2: continue
        pslug, oid = parts
        pm = poly_by_slug.get(pslug)
        om = op_by_id.get(oid)
        if pm and om:
            sim = compute_similarity(pm, om)
            matches.append((pm, om, sim))
    return matches


# ════════════════════════════════════════════════════════════════
# ARBITRAGE DETECTION
# ════════════════════════════════════════════════════════════════
def find_arbitrage(matches: List[Tuple[Market, Market, float]]) -> List[dict]:
    """Detect arbitrage opportunities between matched pairs."""
    opps = []
    for pm, om, sim in matches:
        if not om.has_prices: continue
        py, pn = pm.yes_price, pm.no_price
        oy, on = om.yes_price, om.no_price

        if oy in (0.0, 1.0) or on in (0.0, 1.0): continue

        # Cost to buy YES on Poly + NO on Opinion
        c1 = py + on
        p1 = (1.0 - c1) * 100

        # Cost to buy NO on Poly + YES on Opinion
        c2 = pn + oy
        p2 = (1.0 - c2) * 100

        spread = (oy - py) * 100

        base = {
            "poly": pm, "op": om, "sim": sim, "spread": spread,
        }

        if p1 >= MIN_PROF:
            opps.append({**base, "dir": "py_on", "prof": p1,
                "strat": f"BUY Poly YES ({py:.2f}) + Op {om.no_label} ({on:.2f})"})
        if p2 >= MIN_PROF:
            opps.append({**base, "dir": "pn_oy", "prof": p2,
                "strat": f"BUY Poly NO ({pn:.2f}) + Op {om.yes_label} ({oy:.2f})"})

    opps.sort(key=lambda x: x["prof"], reverse=True)
    return opps


# ════════════════════════════════════════════════════════════════
# TELEGRAM BOT
# ════════════════════════════════════════════════════════════════
_bot = Bot(token=TG_TOKEN)
_tgq: asyncio.Queue = asyncio.Queue()
_db = PairsDB()
_learner = PatternLearner()

# Short ID mapping for Telegram buttons (callback_data max 64 bytes)
_btn_map: Dict[str, str] = {}
_btn_counter = 0

def _short_id(pair_key: str) -> str:
    global _btn_counter
    for sid, pk in _btn_map.items():
        if pk == pair_key: return sid
    _btn_counter += 1
    sid = f"p{_btn_counter}"
    _btn_map[sid] = pair_key
    return sid


async def _tg_loop():
    while True:
        text, pm, keyboard = await _tgq.get()
        # Send to private chat
        try:
            await _bot.send_message(chat_id=TG_CHAT, text=text, parse_mode=pm,
                                    reply_markup=keyboard)
        except Exception as e:
            print(f"  TG private: {e}")
        # Send to group thread
        try:
            await _bot.send_message(chat_id=TG_GROUP, text=text, parse_mode=pm,
                                    reply_markup=keyboard,
                                    message_thread_id=TG_THREAD)
        except Exception as e:
            print(f"  TG group: {e}")
        _tgq.task_done()
        await asyncio.sleep(0.3)

async def tg(text: str, pm=ParseMode.MARKDOWN, keyboard=None):
    await _tgq.put((text, pm, keyboard))


async def send_curation(pair_key: str, poly_q: str, op_q: str, sim: float, spread: float):
    """Send Telegram message with approve/reject buttons."""
    pq = safe(poly_q[:50]).replace("`","'").replace("*","")
    oq = safe(op_q[:50]).replace("`","'").replace("*","")
    text = (
        f"🆕 Nuevo Par\n"
        f"P: {pq}\n"
        f"O: {oq}\n"
        f"Sim: {sim:.0%} Spread: {spread:+.1f}%"
    )
    sid = _short_id(pair_key)
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton("✅ Approve", callback_data=f"a|{sid}"),
         InlineKeyboardButton("❌ Reject", callback_data=f"r|{sid}")]
    ])
    await tg(text, pm=None, keyboard=keyboard)


async def handle_callback(update: Update, context=None):
    """Handle approve/reject button presses."""
    query = update.callback_query
    data = query.data
    try:
        action, sid = data.split("|", 1)
    except:
        await _bot.answer_callback_query(query.id, text="Error")
        return

    key = _btn_map.get(sid)
    if not key:
        await _bot.answer_callback_query(query.id, text="Expired - restart bot")
        return

    try:
        if action == "a":
            if _db.approve(key):
                await _bot.answer_callback_query(query.id, text="Approved!")
                try:
                    await _bot.edit_message_text(
                        chat_id=query.message.chat_id,
                        message_id=query.message.message_id,
                        text=f"✅ APPROVED\n{query.message.text}")
                except: pass
                a, r, p = _db.stats()
                print(f"  ✅ Approved: {safe(key[:40])} | {a}A {r}R {p}P")
            else:
                await _bot.answer_callback_query(query.id, text="Already processed")

        elif action == "r":
            pair = _db.reject(key, reason="manual")
            if pair:
                patterns = _learner.learn(pair.get("poly_q",""), pair.get("op_q",""), "manual")
                pdesc = ", ".join(p["type"] for p in patterns[:3]) if patterns else "none"
                await _bot.answer_callback_query(query.id, text="Rejected + Learned!")
                try:
                    await _bot.edit_message_text(
                        chat_id=query.message.chat_id,
                        message_id=query.message.message_id,
                        text=f"❌ REJECTED (learned: {pdesc})\n{query.message.text}")
                except: pass
                a, r, p = _db.stats()
                print(f"  ❌ Rejected: {safe(key[:40])} | learned: {pdesc} | {a}A {r}R {p}P")
            else:
                await _bot.answer_callback_query(query.id, text="Already processed")
    except Exception as e:
        try: await _bot.answer_callback_query(query.id, text=f"Error: {str(e)[:30]}")
        except: pass


_tg_poll_offset: int = 0

async def _tg_callback_poll_loop():
    """Manual polling for Telegram callback queries.
    Replaces ApplicationBuilder/Updater which is broken on Python 3.14.
    Only processes callback_query updates (button presses).
    """
    global _tg_poll_offset
    # Drop pending updates on startup
    try:
        updates = await _bot.get_updates(offset=-1, timeout=0)
        if updates:
            _tg_poll_offset = updates[-1].update_id + 1
    except:
        pass

    while True:
        try:
            updates = await _bot.get_updates(
                offset=_tg_poll_offset, timeout=15,
                allowed_updates=["callback_query"],
            )
            for update in updates:
                _tg_poll_offset = update.update_id + 1
                if update.callback_query:
                    try:
                        await handle_callback(update)
                    except Exception as e:
                        print(f"  ⚠️ Callback error: {e}")
        except asyncio.CancelledError:
            break
        except Exception as e:
            # Network error, rate limit, etc — wait and retry
            await asyncio.sleep(3)


_alerted: Dict[str, float] = {}

async def alert_arb(opp: dict):
    """Send professional dashboard-style arbitrage alert to Telegram."""
    pm_mkt, om = opp["poly"], opp["op"]
    k = f"{pm_mkt.slug}|{om.id}|{opp['dir']}"
    now = time.time()
    if (now - _alerted.get(k, 0)) < ALERT_CD: return
    _alerted[k] = now

    prof = opp["prof"]
    spread = opp["spread"]
    sim = opp["sim"]
    d = opp["dir"]

    # Determine buy sides
    if d == "py_on":
        poly_side, poly_price = "YES", pm_mkt.yes_price
        op_side, op_price = om.no_label, om.no_price
    else:
        poly_side, poly_price = "NO", pm_mkt.no_price
        op_side, op_price = om.yes_label, om.yes_price

    total_cost = poly_price + op_price
    roi = ((1.0 - total_cost) / total_cost * 100) if total_cost > 0 else 0
    profit_1k = (1.0 - total_cost) / total_cost * 1000 if total_cost > 0 else 0

    # URLs
    poly_url = f"https://polymarket.com/event/{pm_mkt.slug}"
    op_id = om.parent_id if om.parent_id else om.id
    opinion_url = f"https://opinion.trade/market/{op_id}"

    # Escape HTML special chars in questions
    pq = safe(pm_mkt.question[:70]).replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")
    oq = safe(om.question[:70]).replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

    ts = datetime.now(timezone.utc).strftime("%H:%M:%S UTC")

    msg = (
        f"{'─'*30}\n"
        f"🟩 <b>ARBITRAGE  +{prof:.1f}%  |  ROI {roi:.1f}%</b>\n"
        f"{'─'*30}\n"
        f"\n"
        f"🟦 <b>POLYMARKET</b>\n"
        f"   {pq}\n"
        f"   YES <code>{pm_mkt.yes_price:.3f}</code>  |  NO <code>{pm_mkt.no_price:.3f}</code>\n"
        f"\n"
        f"🟧 <b>OPINION LABS</b>\n"
        f"   {oq}\n"
        f"   {om.yes_label} <code>{om.yes_price:.3f}</code>  |  {om.no_label} <code>{om.no_price:.3f}</code>\n"
        f"\n"
        f"{'─'*30}\n"
        f"⚡ <b>ESTRATEGIA (HEDGE)</b>\n"
        f"\n"
        f"   🟢 COMPRA POLY {poly_side}   @ <code>{poly_price:.3f}</code>\n"
        f"   🟠 COMPRA OPINION {op_side}  @ <code>{op_price:.3f}</code>\n"
        f"\n"
        f"{'─'*30}\n"
        f"💰 <b>CALCULO</b>\n"
        f"   Coste total:  <code>{total_cost:.4f}</code>\n"
        f"   Payout:       <code>1.0000</code>\n"
        f"   Beneficio:    <code>+{prof:.2f}%</code>\n"
        f"   Spread:       <code>{spread:+.1f}%</code>\n"
        f"\n"
        f"   💵 <b>Por $1,000 invertidos → +${profit_1k:.2f}</b>\n"
        f"\n"
        f"   Match: {sim:.0%}  |  {ts}\n"
        f"{'─'*30}\n"
    )

    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton("🟦 Ir a Polymarket", url=poly_url),
         InlineKeyboardButton("🟧 Ir a Opinion.trade", url=opinion_url)]
    ])
    await tg(msg, pm=ParseMode.HTML, keyboard=keyboard)


# ════════════════════════════════════════════════════════════════
# DISPLAY
# ════════════════════════════════════════════════════════════════
def show(cyc, mode, lat, np, no, candidates, opps, new, db_stats):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    a, r, p = db_stats
    st = "🟢" if opps else ("🔵" if candidates else "⚪")
    icon = "🔍" if mode == "discover" else "📡"
    ws = "WS" if _poly_ws_connected else "REST"
    print(f"{st}{icon} #{cyc:>4} | {ts} | {lat:>4}ms | P:{np}({ws}) O:{no} | "
          f"M:{len(candidates)} A:{len(opps)} | {a}✅{r}❌{p}⏳")

    if mode == "discover" and candidates and (cyc == 1 or cyc % 5 == 0):
        print(f"  ┌─ Discovery ({len(candidates)} candidates):")
        for pm, om, sim, status in candidates[:15]:
            ic = {"approved":"✅","pending":"⏳","new":"🆕"}.get(status, "?")
            tp = "📦" if om.market_type == "child" else "📄"
            print(f"  │{ic}{tp} [{sim:.0%}] {safe(pm.question[:35])} <> {safe(om.question[:35])}")
        if len(candidates) > 15:
            print(f"  │ ... +{len(candidates)-15} more")
        print(f"  └─")

    if opps and new:
        for o in opps[:5]:
            print(f"  💰 {o['prof']:.1f}% | {o['strat']}")
            print(f"     P: {safe(o['poly'].question[:55])}")
            print(f"     O: {safe(o['op'].question[:55])}")


# ════════════════════════════════════════════════════════════════
# MAIN LOOP
# ════════════════════════════════════════════════════════════════
async def main():
    print("╔══════════════════════════════════════════════════════════╗")
    print("║  🧠 ProphetLabs v15.0 — LLM + PRO ALERTS                  ║")
    print("║  Polymarket + Opinion | MiniMax M2.5 | Dashboard Alerts    ║")
    print("╚══════════════════════════════════════════════════════════╝\n")

    a, r, p = _db.stats()
    print(f"  📋 DB: {a} approved, {r} rejected, {p} pending")
    print(f"  🧠 Learned patterns: {len(_learner.rules)}")
    if LLM_KEY and LLM_ENABLED:
        print(f"  🤖 LLM: {LLM_MODEL} via OpenRouter")
    else:
        print(f"  ⚠️ LLM: disabled (set LLM_KEY + LLM_ENABLED for auto-validation)")

    # Clean up stale pending pairs
    if _db.pending:
        stale = len(_db.pending)
        if LLM_KEY and LLM_ENABLED:
            print(f"  📋 {stale} pending pairs — will re-validate with LLM on first discover cycle")
        else:
            print(f"  📋 {stale} pending pairs — approve/reject via Telegram")

    # Start Telegram callback polling (manual — avoids Updater bug on Python 3.14)
    asyncio.create_task(_tg_callback_poll_loop())
    asyncio.create_task(_tg_loop())

    try:
        startup_msg = (f"ProphetLabs v15.1 Online\n"
                      f"P:{POLY_PAGES*POLY_PP}(WS) O:{OP_PAGES*OP_PP} markets\n"
                      f"LLM: {LLM_MODEL}\n"
                      f"DB: {a}A {r}R {p}P")
        await _bot.send_message(chat_id=TG_CHAT, text=startup_msg)
        print("✅ Telegram private OK")
    except Exception as e:
        print(f"⚠️ TG private: {e}")

    try:
        await _bot.send_message(chat_id=TG_GROUP, text=startup_msg,
                                message_thread_id=TG_THREAD)
        print("✅ Telegram group OK")
    except Exception as e:
        print(f"⚠️ TG group ({TG_GROUP} thread {TG_THREAD}): {e}")
    print()

    conn = aiohttp.TCPConnector(limit=40, keepalive_timeout=30)
    async with aiohttp.ClientSession(connector=conn) as session:
        cyc = 0
        prev_arb_keys: set = set()
        discover_interval = 3

        # Start Polymarket WebSocket background task
        global _poly_ws_task
        _poly_ws_task = asyncio.create_task(_poly_ws_loop())
        print("🔌 Polymarket WebSocket task started")

        while True:
            cyc += 1
            t0 = time.time()

            a, r, p = _db.stats()
            run_discover = (cyc == 1 or cyc % discover_interval == 0)
            mode = "discover" if run_discover else "monitor"

            # ── Fetch data from both exchanges ──
            poly_markets, op_markets = await asyncio.gather(
                fetch_polymarket(session),
                fetch_opinion(session, cyc),
                return_exceptions=True,
            )
            if isinstance(poly_markets, Exception): poly_markets = []
            if isinstance(op_markets, Exception): op_markets = []

            # ── Update Polymarket prices from WebSocket ──
            ws_updates = 0
            if _poly_ws_connected and poly_markets:
                for pm in poly_markets:
                    if poly_ws_update_market_prices(pm):
                        ws_updates += 1
            if cyc <= 3 and ws_updates:
                print(f"  📡 WS updated {ws_updates}/{len(poly_markets)} Poly prices")

            candidates = []
            matches_for_arb: List[Tuple[Market, Market, float]] = []

            if mode == "discover" and poly_markets and op_markets:
                # ── DISCOVERY MODE ──
                candidates = discover_candidates(poly_markets, op_markets, _db, _learner)

                # Separate candidates that need LLM validation
                new_candidates = []
                for pm, om, sim, status in candidates:
                    if status in ("new", "pending"):  # pending = LLM failed last time
                        key = PairsDB.make_key(pm.slug, om.id)
                        new_candidates.append((key, pm, om, sim))

                # ── RULE-BASED PRE-FILTER (deterministic, no LLM needed) ──
                need_llm = []
                rule_approved = 0
                rule_rejected = 0
                for key, pm, om, sim in new_candidates:
                    verdict = rule_match(pm, om)
                    if verdict is True:
                        _db.add_pending(key, pm.question, om.question, sim)
                        _db.approve(key)
                        rule_approved += 1
                        print(f"  ✅ Rule [{sim:.0%}]: {safe(pm.question[:40])} <> {safe(om.question[:40])}")
                    elif verdict is False:
                        _db.add_pending(key, pm.question, om.question, sim)
                        _db.reject(key, reason="rule_rejected")
                        rule_rejected += 1
                    else:
                        need_llm.append((key, pm, om, sim))

                if rule_approved or rule_rejected:
                    print(f"  📋 Rules: {rule_approved}✅ {rule_rejected}❌ {len(need_llm)}→LLM")

                # ── LLM VALIDATION (only ambiguous candidates) ──
                if LLM_KEY and LLM_ENABLED and need_llm:
                    # Batch in chunks of 15 to avoid model confusion
                    LLM_BATCH = 15
                    all_verdicts = {}
                    for i in range(0, len(need_llm), LLM_BATCH):
                        chunk = need_llm[i:i+LLM_BATCH]
                        llm_input = [(k, pm.question, om.question, pm, om) for k, pm, om, sim in chunk]
                        verdicts = await llm_validate_batch(session, llm_input)
                        all_verdicts.update(verdicts)
                        if i + LLM_BATCH < len(need_llm):
                            await asyncio.sleep(1)  # Rate limit between batches

                    for key, pm, om, sim in need_llm:
                        _db.add_pending(key, pm.question, om.question, sim)
                        if key in all_verdicts:
                            if all_verdicts[key]:
                                _db.approve(key)
                                print(f"  ✅ LLM [{sim:.0%}]: {safe(pm.question[:40])} <> {safe(om.question[:40])}")
                            elif sim >= 0.80:
                                # High sim but LLM said no — send to Telegram for manual check
                                await send_curation(key, pm.question, om.question, sim, 0.0)
                                print(f"  🔍 Review [{sim:.0%}]: {safe(pm.question[:40])} <> {safe(om.question[:40])}")
                                await asyncio.sleep(0.3)
                            else:
                                _db.reject(key, reason="llm_rejected")
                                print(f"  ❌ LLM [{sim:.0%}]: {safe(pm.question[:40])} <> {safe(om.question[:40])}")
                        # If LLM didn't validate this pair, it stays pending for next discover cycle

                # ── NO LLM: fallback to rules + Telegram ──
                elif need_llm:
                    for key, pm, om, sim in need_llm:
                        if sim >= 0.90:
                            _db.add_pending(key, pm.question, om.question, sim)
                            _db.approve(key)
                            print(f"  ✅ Auto [{sim:.0%}]: {safe(pm.question[:40])} <> {safe(om.question[:40])}")
                        else:
                            added = _db.add_pending(key, pm.question, om.question, sim)
                            if added:
                                await send_curation(key, pm.question, om.question, sim, 0.0)
                                await asyncio.sleep(0.3)

                # Also collect approved pairs for price fetching
                approved_from_disc = [(pm, om, sim) for pm, om, sim, st in candidates
                                      if _db.status(PairsDB.make_key(pm.slug, om.id)) == "approved"]
                approved_monitor = monitor_approved(poly_markets, op_markets, _db)

                # Merge + dedupe
                seen = set()
                for pm, om, sim in approved_from_disc + approved_monitor:
                    k = f"{pm.slug}|{om.id}"
                    if k not in seen:
                        seen.add(k)
                        matches_for_arb.append((pm, om, sim))

            elif poly_markets and op_markets:
                # ── MONITOR MODE — fast ──
                matches_for_arb = monitor_approved(poly_markets, op_markets, _db)
                candidates = [(pm, om, sim, "approved") for pm, om, sim in matches_for_arb]

            # ── Fetch Opinion prices for matched markets ──
            # (Skip markets that already have inline prices from listing)
            need_prices = [(pm, om, sim) for pm, om, sim in matches_for_arb if not om.has_prices]
            price_tasks = []
            for _, om, _ in need_prices[:MAX_PRICES]:
                price_tasks.append(fetch_opinion_price(session, om.yes_token, om.no_token))

            if price_tasks:
                results = await asyncio.gather(*price_tasks, return_exceptions=True)
                got_prices = 0
                for (_, om, _), res in zip(need_prices[:MAX_PRICES], results):
                    if isinstance(res, tuple) and res[0] is not None:
                        yp, np = res
                        om.prices[om.yes_label] = yp
                        om.prices[om.no_label] = np
                        got_prices += 1
                skipped = len(matches_for_arb) - len(need_prices)
                if cyc <= 2:
                    print(f"  [PRICES] Fetched {got_prices}/{len(price_tasks)} OP prices "
                          f"({skipped} had inline prices)")

            # ── Subscribe matched Poly tokens to WebSocket ──
            if matches_for_arb:
                poly_tokens = set()
                for pm, om, sim in matches_for_arb:
                    for tid in pm.token_ids.values():
                        if tid: poly_tokens.add(tid)
                if poly_tokens - _poly_ws_subscribed:
                    await poly_ws_ensure_subscribed(poly_tokens)
                    if cyc <= 3:
                        print(f"  📡 WS tracking {len(_poly_ws_subscribed)} Poly tokens")

            # ── Detect arbitrage ──
            opps = find_arbitrage(matches_for_arb) if matches_for_arb else []

            cur_keys = set()
            new_arb = False
            for o in opps:
                k = f"{o['poly'].slug}|{o['op'].id}|{o['dir']}"
                cur_keys.add(k)
                if k not in prev_arb_keys:
                    new_arb = True
                    await alert_arb(o)
            prev_arb_keys = cur_keys

            # ── Display ──
            lat = int((time.time() - t0) * 1000)
            show(cyc, mode, lat, len(poly_markets), len(op_markets),
                 candidates, opps, new_arb, _db.stats())

            # ── Wait ──
            poll = POLL_DISCOVER if mode == "discover" else POLL_MONITOR
            wait = max(0, poll - (time.time() - t0))
            if wait > 0:
                await asyncio.sleep(wait)


# ════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n🛑 v15.1 detenido.")
        a, r, p = _db.stats()
        print(f"  📋 Final: {a}✅ {r}❌ {p}⏳ | Patterns: {len(_learner.rules)}")
        print(f"  📡 WS prices cached: {len(_poly_ws_prices)} tokens")
    except Exception as e:
        print(f"\n💀 Fatal: {e}")
        import traceback; traceback.print_exc()
