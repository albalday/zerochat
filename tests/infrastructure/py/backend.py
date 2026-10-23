"""Carga zerochat.py una sola vez por proceso para todas las pruebas de unittest."""

import importlib.util
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location("zerochat", Path(__file__).resolve().parents[3] / "zerochat.py")
zerochat = importlib.util.module_from_spec(_spec)
sys.modules["zerochat"] = zerochat
_spec.loader.exec_module(zerochat)
