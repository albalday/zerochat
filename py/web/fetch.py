"""Transporte web saliente del servidor (zerochat/web/fetch): anti-SSRF en la URL y en cada redirección, cuerpo acotado, cabeceras de navegador y frecuencia por dominio."""

from __future__ import annotations

import base64
import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import zlib

from browser.config import DEFAULT_USER_AGENT, load_last_frontend_user_agent, save_last_frontend_user_agent, set_service_user_agent
from core.rate_limit import RATE_LIMITER, RateLimitBusy, RatePolicy

METADATA_HOSTS = frozenset({
    "169.254.169.254",
    "metadata.google.internal",
    "instance-data",
    "100.100.100.200",
})
# El User-Agent activo se sustituye por el de la primera petición del frontend (variabilidad de
# fingerprint); sin frontend (--prompt/--conversation) se usa el último guardado o el por defecto.
ACTIVE_USER_AGENT = DEFAULT_USER_AGENT
# Último User-Agent real guardado en SQLite: se lee una sola vez por proceso, no en cada petición web.
_STORED_USER_AGENT: str | None = None
_STORED_USER_AGENT_LOADED = False


def capture_frontend_user_agent(user_agent: str) -> None:
    """Adopta y persiste el User-Agent de la primera petición del frontend para las salidas web y Playwright."""
    global ACTIVE_USER_AGENT, _STORED_USER_AGENT, _STORED_USER_AGENT_LOADED
    cleaned = user_agent.strip() if isinstance(user_agent, str) else ""
    if ACTIVE_USER_AGENT is DEFAULT_USER_AGENT and cleaned:
        ACTIVE_USER_AGENT = cleaned
        set_service_user_agent(ACTIVE_USER_AGENT, from_frontend=True)
        save_last_frontend_user_agent(cleaned)
        _STORED_USER_AGENT, _STORED_USER_AGENT_LOADED = cleaned, True


def effective_user_agent() -> str:
    """User-Agent activo del servidor o, en desatendido sin frontend, el último capturado del navegador."""
    global _STORED_USER_AGENT, _STORED_USER_AGENT_LOADED
    if ACTIVE_USER_AGENT is not DEFAULT_USER_AGENT:
        return ACTIVE_USER_AGENT
    if not _STORED_USER_AGENT_LOADED:
        _STORED_USER_AGENT, _STORED_USER_AGENT_LOADED = load_last_frontend_user_agent(), True
    return _STORED_USER_AGENT or DEFAULT_USER_AGENT


WEB_FETCH_MAX_BYTES = 10 * 1024 * 1024
WEB_FETCH_MAX_REDIRECTS = 5
WEB_FETCH_READ_CHUNK = 64 * 1024
TEXT_CONTENT_TYPE_RE = re.compile(
    r"^(text/|application/(json|xml|xhtml\+xml|javascript|x-javascript|ecmascript)$|[a-z]+/[^;]*\+(json|xml)$)"
)
# Frecuencia por dominio frente a retos anti-bot: DuckDuckGo responde con un reto (HTTP 202) a peticiones seguidas o
# simultáneas, así que van de una en una y con 2 s desde la respuesta anterior. Vale para cualquier herramienta que
# pida el dominio o un subdominio, no solo para search_web.
WEB_FETCH_DOMAIN_LIMITS = {
    "duckduckgo.com": RatePolicy(concurrency=1, min_interval_s=2.0),
}


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

    timeout_s = max(0.5, min(float(params.get("timeout_s", 10.0)), 30.0))
    limited = next((domain for domain in WEB_FETCH_DOMAIN_LIMITS if hostname == domain or hostname.endswith("." + domain)), None)
    if limited is None:
        return _fetch_web_resource_unpaced(url, params, hostname, parsed, timeout_s)
    # La espera del turno sale del plazo de la petición: la interfaz no espera más que ese plazo y su margen.
    try:
        with RATE_LIMITER.slot(limited, WEB_FETCH_DOMAIN_LIMITS[limited], max_wait_s=timeout_s - 0.5) as waited:
            return _fetch_web_resource_unpaced(url, params, hostname, parsed, max(0.5, timeout_s - waited))
    except RateLimitBusy as exc:
        return {"ok": False, "status": 0, "error": str(exc)}


def _fetch_web_resource_unpaced(url: str, params: dict, hostname: str, parsed, timeout_s: float) -> dict:
    """Cuerpo de fetch_web_resource sin el control de frecuencia: cabeceras, descarga y respuesta."""
    max_bytes = max(1024, min(int(params.get("max_bytes", 2 * 1024 * 1024)), WEB_FETCH_MAX_BYTES))
    as_binary = bool(params.get("binary", False))
    accept = params.get("accept")
    req_headers = {
        "User-Agent": effective_user_agent(),
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
    if hostname == "duckduckgo.com" or hostname.endswith(".duckduckgo.com"):
        req_headers["Referer"] = f"{parsed.scheme}://{parsed.netloc}/"

    # El esquema (http/https) se valida antes, también en cada redirección.
    req = urllib.request.Request(url, headers=req_headers)  # noqa: S310
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
    except PermissionError:
        # Una redirección hacia un destino bloqueado es el mismo rechazo anti-SSRF que la URL pedida.
        raise
    except Exception as exc:
        return {
            "ok": False,
            "status": 0,
            "error": str(exc)
        }
