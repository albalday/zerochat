"""Transporte web saliente del servidor (zerochat/web/fetch): anti-SSRF en la URL y en cada redirección, cuerpo acotado, cabeceras de navegador y cadencia por host."""

from __future__ import annotations

import base64
import ipaddress
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

from browser.config import set_service_user_agent

METADATA_HOSTS = frozenset({
    "169.254.169.254",
    "metadata.google.internal",
    "instance-data",
    "100.100.100.200",
})
DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
# El User-Agent activo se sustituye por el de la primera petición del frontend (variabilidad de
# fingerprint); sin frontend (--prompt/--conversation) se queda el valor por defecto.
ACTIVE_USER_AGENT = DEFAULT_USER_AGENT


def capture_frontend_user_agent(user_agent: str) -> None:
    """Adopta el User-Agent de la primera petición del frontend como User-Agent de las salidas web."""
    global ACTIVE_USER_AGENT
    if ACTIVE_USER_AGENT is DEFAULT_USER_AGENT and isinstance(user_agent, str) and user_agent.strip():
        ACTIVE_USER_AGENT = user_agent.strip()
        set_service_user_agent(ACTIVE_USER_AGENT)


# Los motores propios de Playwright arrancan con el User-Agent por defecto hasta que el
# frontend fija el suyo en la primera petición.
set_service_user_agent(DEFAULT_USER_AGENT)
WEB_FETCH_MAX_BYTES = 10 * 1024 * 1024
WEB_FETCH_MAX_REDIRECTS = 5
WEB_FETCH_READ_CHUNK = 64 * 1024
TEXT_CONTENT_TYPE_RE = re.compile(
    r"^(text/|application/(json|xml|xhtml\+xml|javascript|x-javascript|ecmascript)$|[a-z]+/[^;]*\+(json|xml)$)"
)
# Control de cadencia frente a retos anti-bot: mínimo WEB_FETCH_MIN_GAP_S desde la RESPUESTA
# anterior al mismo host; las peticiones en paralelo se escalonan de WEB_FETCH_PARALLEL_STAGGER_S
# en WEB_FETCH_PARALLEL_STAGGER_S para que no coincidan. El timestamp se inicializa al arrancar
# para que la primera petición espere aunque no se haya hecho ninguna antes.
_WEB_FETCH_LOCK = threading.Lock()
_LAST_WEB_FETCH_AT: dict[str, float] = {"duckduckgo.com": time.monotonic()}
_WEB_FETCH_PENDING: dict[str, int] = {}
WEB_FETCH_HOST_PACING_DOMAINS = ("duckduckgo.com",)
WEB_FETCH_MIN_GAP_S = 2.0
WEB_FETCH_PARALLEL_STAGGER_S = 5.0


def _is_public_ip(address: str) -> bool:
    """Una dirección es pública si es global y no multicast; las IPv4 mapeadas en IPv6 se evalúan como IPv4."""
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


# Una dirección IPv4 en notación numérica: partes decimales o hexadecimales (0x…), de una a cuatro.
_NUMERIC_HOST = re.compile(r"(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+)){0,3}")


def is_dangerous_host(hostname: str) -> bool:
    """Riesgo de SSRF: metadatos cloud, nombres locales o cualquier dirección resuelta no pública."""
    clean_host = (hostname or "").strip().lower().strip("[]").rstrip(".")
    if not clean_host or clean_host in METADATA_HOSTS or clean_host == "localhost":
        return True
    if clean_host.endswith((".localhost", ".local", ".internal")):
        return True
    if _NUMERIC_HOST.fullmatch(clean_host):
        # Abreviadas, enteras, hexadecimales u octales (127.1, 2130706433, 0x7f.1, 0177.0.0.1): cada
        # resolvedor las interpreta a su manera, así que solo se admite la forma canónica.
        try:
            ipaddress.IPv4Address(clean_host)
        except ValueError:
            return True
    try:
        infos = socket.getaddrinfo(clean_host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        # Sin resolución no hay conexión posible: la petición fallará por sí misma.
        return False
    return any(not _is_public_ip(info[4][0]) for info in infos)


def _validate_web_url(url: str) -> str:
    """Valida esquema y host de una URL de descarga (también de cada redirección)."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Protocolo no permitido: '{parsed.scheme}'. Solo se admite http y https.")
    if not parsed.hostname:
        raise ValueError("URL sin nombre de host válido.")
    if is_dangerous_host(parsed.hostname):
        raise PermissionError("Acceso bloqueado: intento de acceso a servicios internos o metadatos de infraestructura (SSRF).")
    return url


class _ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Sigue redirecciones solo si el destino supera la misma validación anti-SSRF que la URL pedida."""
    max_redirections = WEB_FETCH_MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_web_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_WEB_OPENER = urllib.request.build_opener(_ValidatingRedirectHandler)


def _read_limited_body(stream, content_encoding: str, max_bytes: int) -> tuple[bytes, bool]:
    """Lee el cuerpo ya descomprimido hasta `max_bytes`; indica si había más (truncado)."""
    encoding = (content_encoding or "").strip().lower()
    # MAX_WBITS | 32 detecta la cabecera gzip o zlib.
    decompressor = zlib.decompressobj(zlib.MAX_WBITS | 32) if encoding in ("gzip", "x-gzip", "deflate") else None
    data = bytearray()
    while len(data) <= max_bytes:
        chunk = stream.read(WEB_FETCH_READ_CHUNK)
        if not chunk:
            break
        if decompressor:
            # La salida se limita al hueco restante: un cuerpo comprimido no puede crecer sin tope.
            chunk = decompressor.decompress(chunk, max_bytes + 1 - len(data))
        data += chunk
    truncated = len(data) > max_bytes
    return bytes(data[:max_bytes]), truncated


def is_text_content_type(content_type: str) -> bool:
    """Tipos que se devuelven como texto; el resto viaja en base64."""
    media_type = (content_type or "").split(";", 1)[0].strip().lower()
    return not media_type or bool(TEXT_CONTENT_TYPE_RE.match(media_type))


def fetch_web_resource(params: dict) -> dict:
    """Descarga de forma segura un recurso web vía HTTP/HTTPS para el cliente web."""
    url = params.get("url")
    if not isinstance(url, str) or not url.strip():
        raise ValueError("URL no válida o ausente.")
    url = _validate_web_url(url.strip())

    parsed = urllib.parse.urlsplit(url)
    hostname = (parsed.hostname or "").lower()

    # Hosts sensibles (ej. DuckDuckGo): esperar al menos WEB_FETCH_MIN_GAP_S desde la respuesta
    # anterior y escalar las peticiones en paralelo de a WEB_FETCH_PARALLEL_STAGGER_S.
    pacing_domain = next(
        (domain for domain in WEB_FETCH_HOST_PACING_DOMAINS if hostname == domain or hostname.endswith("." + domain)),
        None,
    )
    if pacing_domain is None:
        return _fetch_web_resource_unpaced(url, params, hostname, parsed)

    with _WEB_FETCH_LOCK:
        pending = _WEB_FETCH_PENDING.get(pacing_domain, 0)
        gap = time.monotonic() - _LAST_WEB_FETCH_AT.get(pacing_domain, 0.0)
        sleep_needed = max(0.0, WEB_FETCH_MIN_GAP_S - gap) + WEB_FETCH_PARALLEL_STAGGER_S * pending
        _WEB_FETCH_PENDING[pacing_domain] = pending + 1
    try:
        if sleep_needed > 0:
            time.sleep(sleep_needed)
        return _fetch_web_resource_unpaced(url, params, hostname, parsed)
    finally:
        # El timestamp marca la respuesta (o el intento) terminado: la próxima petición
        # cuenta los 2 s desde aquí.
        with _WEB_FETCH_LOCK:
            _LAST_WEB_FETCH_AT[pacing_domain] = time.monotonic()
            _WEB_FETCH_PENDING[pacing_domain] = max(0, _WEB_FETCH_PENDING[pacing_domain] - 1)


def _fetch_web_resource_unpaced(url: str, params: dict, hostname: str, parsed) -> dict:
    """Cuerpo de fetch_web_resource sin cadencia: cabeceras, descarga y respuesta."""
    timeout_s = max(0.5, min(float(params.get("timeout_s", 10.0)), 30.0))
    max_bytes = max(1024, min(int(params.get("max_bytes", 2 * 1024 * 1024)), WEB_FETCH_MAX_BYTES))
    as_binary = bool(params.get("binary", False))
    accept = params.get("accept")
    req_headers = {
        "User-Agent": ACTIVE_USER_AGENT,
        "Accept": accept if isinstance(accept, str) and accept else "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
    }
    if hostname.endswith("duckduckgo.com"):
        req_headers["Referer"] = f"{parsed.scheme}://{parsed.netloc}/"

    req = urllib.request.Request(url, headers=req_headers)
    try:
        with _WEB_OPENER.open(req, timeout=timeout_s) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw_data, truncated = _read_limited_body(resp, resp.headers.get("Content-Encoding", ""), max_bytes)
            # Las cabeceras de transporte ya no describen el cuerpo descomprimido.
            resp_headers = {k: v for k, v in resp.getheaders() if k.lower() not in ("content-encoding", "content-length")}
            # Respuestas 202 u otros retos anti-bot se marcan como error no exitoso.
            if resp.status == 202:
                return {
                    "ok": False,
                    "status": resp.status,
                    "error": "HTTP 202: Reto anti-bot o verificación de anomalía detectada por el servidor remoto.",
                    "text": raw_data.decode("utf-8", errors="replace")
                }
            result = {
                "ok": True,
                "status": resp.status,
                "url": resp.geturl(),
                "content_type": content_type,
                "headers": resp_headers,
                "byte_size": len(raw_data),
                "truncated": truncated
            }
            if as_binary or not is_text_content_type(content_type):
                result["base64"] = base64.b64encode(raw_data).decode("ascii")
                return result
            charset = resp.headers.get_content_charset() or "utf-8"
            try:
                result["text"] = raw_data.decode(charset, errors="replace")
            except LookupError:
                result["text"] = raw_data.decode("utf-8", errors="replace")
            return result
    except urllib.error.HTTPError as he:
        err_body = ""
        try:
            err_body = he.read(2048).decode("utf-8", errors="replace")
        except OSError:
            pass
        return {
            "ok": False,
            "status": he.code,
            "error": f"HTTP {he.code}: {he.reason}",
            "text": err_body
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": 0,
            "error": str(exc)
        }
