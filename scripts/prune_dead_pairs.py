"""Prune approved pairs whose Opinion Labs market no longer exists.

Checks each approved pair's op_id against the Opinion API and moves
dead ones to `rejected` (reason: market_gone) so the dashboard stops
showing placeholder 0.5 prices for them.

Usage:  python scripts/prune_dead_pairs.py [--dry-run]
"""
import asyncio
import json
import re
import shutil
import sys
from pathlib import Path

import aiohttp

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
PAIRS_FILE = ROOT / "pairs.json"

# Reuse credentials/base from the API module without importing FastAPI
_src = (ROOT / "src" / "api" / "routes.py").read_text(encoding="utf-8")
OP_BASE = re.search(r'OP_BASE\s*=\s*"([^"]+)"', _src).group(1)
OP_KEY = re.search(r'OP_KEY\s*=\s*"([^"]+)"', _src).group(1)
HDR = {"apikey": OP_KEY, "Accept": "application/json"}

CONCURRENCY = 8


async def market_alive(session, sem, op_id: str) -> bool:
    async with sem:
        try:
            async with session.get(f"{OP_BASE}/market/{op_id}", headers=HDR,
                                   timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status != 200:
                    return True  # network doubt → keep the pair
                data = await r.json()
                return data.get("errno") == 0 and data.get("result")
        except Exception:
            return True  # keep on error, only prune confirmed-dead


async def poly_alive(session, sem, slug: str) -> bool:
    """A pair is also dead if its Polymarket market is closed/resolved."""
    async with sem:
        try:
            async with session.get("https://gamma-api.polymarket.com/markets",
                                   params={"slug": slug},
                                   timeout=aiohttp.ClientTimeout(total=10)) as r:
                if r.status != 200:
                    return True
                data = await r.json()
                if not data:
                    return False
                m = data[0]
                return not m.get("closed", False)
        except Exception:
            return True


async def main(dry_run: bool):
    db = json.loads(PAIRS_FILE.read_text(encoding="utf-8"))
    approved = db.get("approved", {})
    print(f"Approved pairs: {len(approved)}")

    sem = asyncio.Semaphore(CONCURRENCY)
    async with aiohttp.ClientSession() as session:
        keys = list(approved.keys())
        ids = [k.split("||")[-1] for k in keys]
        slugs = [k.split("||")[0] for k in keys]
        op_ok = await asyncio.gather(*[market_alive(session, sem, i) for i in ids])
        po_ok = await asyncio.gather(*[poly_alive(session, sem, s) for s in slugs])

    dead = [k for k, o, p in zip(keys, op_ok, po_ok) if not (o and p)]
    print(f"Dead pairs (Opinion gone or Polymarket closed): {len(dead)}")
    for k in dead:
        print(f"  ✗ {approved[k].get('poly_q', k)}")

    if dry_run or not dead:
        print("Dry run — nothing written." if dry_run else "Nothing to prune.")
        return

    shutil.copy(PAIRS_FILE, PAIRS_FILE.with_suffix(".json.bak"))
    rejected = db.setdefault("rejected", {})
    for k in dead:
        entry = approved.pop(k)
        entry["rejected_reason"] = "market_gone"
        rejected[k] = entry
    PAIRS_FILE.write_text(json.dumps(db, indent=2, ensure_ascii=False),
                          encoding="utf-8")
    print(f"Pruned {len(dead)} pairs → moved to rejected. "
          f"Backup: {PAIRS_FILE.name}.bak")


if __name__ == "__main__":
    asyncio.run(main("--dry-run" in sys.argv))
