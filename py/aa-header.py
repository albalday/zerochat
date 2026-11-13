#!/usr/bin/env python3
"""
ZeroChat - Backend Local Unificado y Gestor de Entorno

Proporciona:
1. Auto-creación del entorno MCP local `~/zerochat/.venv`.
2. Servidor local HTTP JSON-RPC con autenticación estricta por token diario e identificación con la cuenta del sistema.
3. Herramientas locales seguras: read_file, edit_file, list_directory, run_command.
4. Apertura automática del navegador apuntando a zerochat.html con token en el fragmento hash.
"""

from __future__ import annotations

import argparse
import atexit
import base64
import contextlib
import ctypes
import ctypes.util
import dataclasses
import datetime
import fnmatch
import functools
import getpass
import hashlib
import hmac
import html
import importlib.metadata
import inspect
import ipaddress
import itertools
import json
import math
import os
import queue
import re
import secrets
import shutil
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import typing
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlencode
import venv
import webbrowser
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


