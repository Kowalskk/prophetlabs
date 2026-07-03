"""Re-audit all APPROVED pairs with the LLM validator.

Old pairs were approved before LLM validation worked (dead key) and some
are semantically wrong ("win the World Cup" vs "reach the final").
Moves LLM-rejected pairs to `rejected` with reason llm_reaudit.

Usage: python scripts/revalidate_pairs.py [--dry-run]
"""
import asyncio
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import conftest  # installs the telegram stub so the backend imports cleanly  # noqa: E402
import aiohttp  # noqa: E402

from src.core import prophetlabs_backend as B  # noqa: E402

PAIRS_FILE = ROOT / "pairs.json"
BATCH = 20


async def main(dry_run: bool):
    if not B.LLM_KEY:
        print("No LLM_KEY set (check .env) — aborting.")
        return

    db = json.loads(PAIRS_FILE.read_text(encoding="utf-8"))
    approved = db.get("approved", {})
    items = [(k, v.get("poly_q", ""), v.get("op_q", ""), None, None)
             for k, v in approved.items()]
    print(f"Re-auditing {len(items)} approved pairs with {B.LLM_MODEL}")

    verdicts = {}
    async with aiohttp.ClientSession() as session:
        for i in range(0, len(items), BATCH):
            chunk = items[i:i + BATCH]
            res = await B.llm_validate_batch(session, chunk)
            verdicts.update(res)
            done = sum(1 for v in verdicts.values() if v is not None)
            print(f"  batch {i//BATCH+1}: {len(res)} verdicts ({done} total)")

    bad = [k for k, ok in verdicts.items() if ok is False]
    print(f"\nLLM rejected {len(bad)} of {len(verdicts)} validated pairs:")
    for k in bad:
        print(f"  ✗ {approved[k].get('poly_q','')[:60]}  <>  {approved[k].get('op_q','')[:50]}")

    if dry_run or not bad:
        print("Dry run — nothing written." if dry_run else "Nothing to move.")
        return

    shutil.copy(PAIRS_FILE, PAIRS_FILE.with_suffix(".json.bak"))
    rejected = db.setdefault("rejected", {})
    for k in bad:
        entry = approved.pop(k)
        entry["rejected_reason"] = "llm_reaudit"
        rejected[k] = entry
    PAIRS_FILE.write_text(json.dumps(db, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Moved {len(bad)} pairs to rejected. Backup: pairs.json.bak")


if __name__ == "__main__":
    asyncio.run(main("--dry-run" in sys.argv))
