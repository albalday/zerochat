"""Catálogo de los servicios MCP incluidos: `services/manifest.json`, publicado junto a la interfaz.

El catálogo, generado por scripts/build-managed-services.mjs, da por servicio su versión y la huella sha256 de cada
fichero. Se descarga de la carpeta de la interfaz (GitHub Pages en producción, este servidor en desarrollo), como el
runner de Node: actualizar un servicio no exige publicar zerochat en PyPI. Solo se copian los servicios cuya versión
instalada difiere, y de ellos solo los ficheros del catálogo: node_modules, .installed.json y los datos del servicio
(como memory.jsonl) se conservan, y los servicios del usuario no se tocan.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import urllib.parse
import urllib.request
from pathlib import Path

from core.version import VERSION

CATALOG_PATH = "services/manifest.json"
CATALOG_SCHEMA_VERSION = 1
# Tope de cada descarga (el catálogo y cada fichero): los de ahora ocupan unos pocos KiB.
CATALOG_MAX_BYTES = 1024 * 1024
CATALOG_TIMEOUT_SECONDS = 10
SERVICE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
# Rutas relativas sin segmentos ocultos ni '..': un segmento no empieza por punto.
SERVICE_FILE_PATTERN = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SERVICE_DEFINITION = "service.json"


def catalog_base(ui_url: str) -> str:
    """Carpeta de la interfaz, de la que cuelga services/."""
    return urllib.parse.urljoin(ui_url.split("#")[0], ".")


def download(url: str) -> bytes:
    """Descarga acotada a CATALOG_MAX_BYTES de un recurso de la carpeta de la interfaz."""
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise ValueError(f"URL del catálogo no admitida: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": f"ZeroChat/{VERSION}", "Cache-Control": "no-cache"})  # noqa: S310
    with urllib.request.urlopen(req, timeout=CATALOG_TIMEOUT_SECONDS) as resp:  # noqa: S310
        data = resp.read(CATALOG_MAX_BYTES + 1)
    if len(data) > CATALOG_MAX_BYTES:
        raise ValueError(f"{url} excede {CATALOG_MAX_BYTES} bytes")
    return data


def parse_catalog(raw: bytes) -> dict[str, dict]:
    """{id: {"version", "files": {ruta: sha256}}} del catálogo; ValueError si no es válido."""
    try:
        catalog = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"El catálogo de servicios no es JSON válido: {exc}") from exc
    if not isinstance(catalog, dict) or catalog.get("schemaVersion") != CATALOG_SCHEMA_VERSION:
        raise ValueError(f"El catálogo de servicios no es de la versión {CATALOG_SCHEMA_VERSION}")
    services = catalog.get("services")
    if not isinstance(services, dict):
        raise ValueError("El catálogo de servicios no tiene services")
    for server_id, entry in services.items():
        if not SERVICE_ID_PATTERN.match(server_id):
            raise ValueError(f"Id de servicio no válido en el catálogo: {server_id!r}")
        if not isinstance(entry, dict) or not isinstance(entry.get("version"), str) or not entry["version"]:
            raise ValueError(f"El servicio {server_id} del catálogo no tiene version")
        files = entry.get("files")
        if not isinstance(files, dict) or SERVICE_DEFINITION not in files:
            raise ValueError(f"El servicio {server_id} del catálogo no incluye {SERVICE_DEFINITION}")
        for path, digest in files.items():
            if not SERVICE_FILE_PATTERN.match(path) or not isinstance(digest, str) or not SHA256_PATTERN.match(digest):
                raise ValueError(f"Fichero no válido en el servicio {server_id} del catálogo: {path!r}")
    return services


def installed_version(services_root: Path, server_id: str) -> str | None:
    """Versión del service.json instalado, o None si falta o no se puede leer."""
    try:
        definition = json.loads((services_root / server_id / SERVICE_DEFINITION).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    version = definition.get("version") if isinstance(definition, dict) else None
    return version if isinstance(version, str) else None


def download_service(base: str, server_id: str, entry: dict) -> dict[str, bytes]:
    """Ficheros de un servicio del catálogo, comprobados contra su huella; ValueError si alguno no coincide."""
    files = {}
    for path, digest in entry["files"].items():
        data = download(urllib.parse.urljoin(base, f"services/{server_id}/{path}"))
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"{server_id}/{path} no coincide con la huella del catálogo")
        files[path] = data
    try:
        definition = json.loads(files[SERVICE_DEFINITION].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{server_id}/{SERVICE_DEFINITION} no es JSON válido: {exc}") from exc
    if not isinstance(definition, dict) or definition.get("id") != server_id or definition.get("version") != entry["version"]:
        raise ValueError(f"{server_id}/{SERVICE_DEFINITION} no tiene el id y la versión del catálogo")
    return files


def install_service(services_root: Path, server_id: str, files: dict[str, bytes]) -> None:
    """Escribe los ficheros del servicio, cada uno de forma atómica; service.json, con la versión, el último."""
    service_dir = services_root / server_id
    for path in sorted(files, key=lambda name: name == SERVICE_DEFINITION):
        destination = service_dir / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Temporal propio de este proceso: otro zerochat puede instalar el mismo servicio a la vez.
        tmp = destination.with_name(f"{destination.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
        try:
            tmp.write_bytes(files[path])
            tmp.replace(destination)
        finally:
            tmp.unlink(missing_ok=True)
