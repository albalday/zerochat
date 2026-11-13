"""Entorno de ejecución: sistema operativo, directorios de datos y de desarrollo y entorno virtual."""

from __future__ import annotations

import os
import sys

DETECTED_OS = "windows" if sys.platform.startswith("win") else ("macos" if sys.platform == "darwin" else ("android" if "ANDROID_ROOT" in os.environ else "linux"))
