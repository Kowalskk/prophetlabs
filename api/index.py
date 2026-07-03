"""Vercel serverless entrypoint — exposes the FastAPI app from src/api/routes.py."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.api.routes import app  # noqa: E402,F401
