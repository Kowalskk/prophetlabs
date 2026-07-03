"""Test fixtures: stub out the telegram dependency so the backend
module can be imported without a bot token or network access."""
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _install_telegram_stub():
    if "telegram" in sys.modules:
        return

    telegram = types.ModuleType("telegram")

    class _Dummy:
        def __init__(self, *args, **kwargs):
            pass

    telegram.Bot = _Dummy
    telegram.Update = _Dummy
    telegram.InlineKeyboardButton = _Dummy
    telegram.InlineKeyboardMarkup = _Dummy

    constants = types.ModuleType("telegram.constants")

    class ParseMode:
        MARKDOWN = "Markdown"
        HTML = "HTML"

    constants.ParseMode = ParseMode

    error = types.ModuleType("telegram.error")

    class TelegramError(Exception):
        pass

    error.TelegramError = TelegramError

    ext = types.ModuleType("telegram.ext")
    ext.Application = _Dummy
    ext.ApplicationBuilder = _Dummy
    ext.CallbackQueryHandler = _Dummy
    ext.CommandHandler = _Dummy
    ext.ContextTypes = types.SimpleNamespace(DEFAULT_TYPE=None)
    ext.MessageHandler = _Dummy
    ext.filters = types.SimpleNamespace(TEXT=None, COMMAND=None)

    telegram.constants = constants
    telegram.error = error
    telegram.ext = ext

    sys.modules["telegram"] = telegram
    sys.modules["telegram.constants"] = constants
    sys.modules["telegram.error"] = error
    sys.modules["telegram.ext"] = ext


_install_telegram_stub()
