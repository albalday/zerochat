#!/usr/bin/env python3
"""Servidor MCP por stdio para correo estándar IMAP y SMTP con librería estándar de Python."""

from __future__ import annotations

import datetime
import email
import email.header
import email.message
import email.policy
import email.utils
from html.parser import HTMLParser
import imaplib
import json
import mimetypes
import os
from pathlib import Path
import re
import smtplib
import ssl
import stat
import sys
import time


SERVER_NAME = "ZeroChat Mail MCP"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"
NETWORK_TIMEOUT_SECONDS = 20
DEFAULT_SEARCH_LIMIT = 20
MAX_SEARCH_LIMIT = 50
MAX_BODY_CHARS = 16_000
MAX_ATTACHMENTS = 50
# Carpeta de salida fija: el servicio solo adjunta ficheros de aquí, por nombre, y los borra tras enviar o guardar.
OUTBOX_DIR = Path(__file__).resolve().parent / "outbox"
MAX_OUTGOING_ATTACHMENTS = 10
# Total sin codificar: en base64 crece un tercio y así queda por debajo de los 25 MB de Gmail.
MAX_OUTGOING_ATTACHMENT_BYTES = 18 * 1024 * 1024
_HOST_PORT_RE = re.compile(r"^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$")
_UID_RE = re.compile(r"^\d+$")
_LIST_LINE_RE = re.compile(r'^\(([^)]*)\)\s+(?:"[^"]*"|NIL)\s+(.+)$')


class _HtmlTextExtractor(HTMLParser):
    """Extrae texto legible de un cuerpo HTML ignorando scripts y estilos."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs):
        lower = tag.lower()
        if lower in ("script", "style", "head"):
            self._skip_depth += 1
        elif self._skip_depth == 0 and lower in ("br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4"):
            self._parts.append("\n")

    def handle_endtag(self, tag: str):
        lower = tag.lower()
        if lower in ("script", "style", "head") and self._skip_depth > 0:
            self._skip_depth -= 1
        elif self._skip_depth == 0 and lower in ("p", "div", "tr", "h1", "h2", "h3", "h4"):
            self._parts.append("\n")

    def handle_data(self, data: str):
        if self._skip_depth == 0 and data:
            self._parts.append(data)

    def text(self) -> str:
        raw = "".join(self._parts)
        return re.sub(r"\n{3,}", "\n\n", raw).strip()


def html_to_text(html_str: str) -> str:
    parser = _HtmlTextExtractor()
    parser.feed(html_str)
    parser.close()
    return parser.text()


def _parse_host_port(raw: str, default_port: int) -> tuple[str, int]:
    match = _HOST_PORT_RE.fullmatch(raw.strip())
    if not match:
        raise ValueError(f"Servidor no válido: {raw!r}")
    host = match.group(1)
    port = int(match.group(2)) if match.group(2) else default_port
    if port < 1 or port > 65535:
        raise ValueError(f"Puerto fuera de rango: {port}")
    return host, port


def _derive_smtp_target(imap_host: str) -> tuple[str, int]:
    lower = imap_host.lower()
    if lower in ("outlook.office365.com", "imap-mail.outlook.com"):
        return "smtp.office365.com", 587
    if lower.startswith("imap."):
        return f"smtp.{imap_host[5:]}", 465
    return imap_host, 465


def parse_mail_config(env: dict[str, str] | None = None) -> dict:
    """Lee y valida la configuración IMAP/SMTP desde las variables de entorno."""
    source = os.environ if env is None else env
    raw_host = (source.get("MAIL_IMAP_HOST") or "").strip()
    user = (source.get("MAIL_USER") or "").strip()
    password = source.get("MAIL_PASSWORD") or ""
    if not raw_host or not user or not password:
        raise ValueError("Faltan MAIL_IMAP_HOST, MAIL_USER o MAIL_PASSWORD.")
    if "|" in raw_host:
        raw_imap, raw_smtp = (part.strip() for part in raw_host.split("|", 1))
        imap_host, imap_port = _parse_host_port(raw_imap, 993)
        smtp_host, smtp_port = _parse_host_port(raw_smtp, 465)
    else:
        imap_host, imap_port = _parse_host_port(raw_host, 993)
        smtp_host, smtp_port = _derive_smtp_target(imap_host)
    return {
        "imap_host": imap_host,
        "imap_port": imap_port,
        "smtp_host": smtp_host,
        "smtp_port": smtp_port,
        "user": user,
        "password": password,
    }


def _quote_imap(value: str) -> str:
    clean = str(value).replace("\r", " ").replace("\n", " ")
    return '"' + clean.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _decode_mime_header(raw: str | None) -> str:
    if not raw:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(raw)))
    except Exception:
        return str(raw)


def _decode_payload_bytes(payload: bytes | None, charset: str | None) -> str:
    if not payload:
        return ""
    for encoding in (charset, "utf-8", "latin-1"):
        if not encoding:
            continue
        try:
            return payload.decode(encoding, errors="replace")
        except LookupError:
            continue
    return payload.decode("utf-8", errors="replace")


def truncate_body(text: str, max_chars: int = MAX_BODY_CHARS) -> tuple[str, bool]:
    """Acota el texto del mensaje a max_chars caracteres indicando si hubo truncado."""
    if len(text) <= max_chars:
        return text, False
    return f"{text[:max_chars]}\n\n[Truncado a {max_chars} caracteres]", True


def _extract_body_and_attachments(msg: email.message.Message) -> tuple[str, list[dict], bool, bool]:
    plain_parts: list[str] = []
    html_parts: list[str] = []
    attachments: list[dict] = []
    attachments_truncated = False

    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        if part.is_multipart():
            continue
        disposition = (part.get_content_disposition() or "").lower()
        filename = _decode_mime_header(part.get_filename())
        content_type = (part.get_content_type() or "application/octet-stream").lower()
        payload = part.get_payload(decode=True)
        raw_bytes = payload if isinstance(payload, bytes) else b""

        if disposition == "attachment" or filename:
            if len(attachments) < MAX_ATTACHMENTS:
                attachments.append({
                    "filename": filename or "unnamed",
                    "content_type": content_type,
                    "size_bytes": len(raw_bytes),
                })
            else:
                attachments_truncated = True
            continue
        text = _decode_payload_bytes(raw_bytes, part.get_content_charset())
        if content_type == "text/plain":
            plain_parts.append(text)
        elif content_type == "text/html":
            html_parts.append(text)

    body_text = "\n".join(p.strip() for p in plain_parts if p.strip()).strip()
    if not body_text and html_parts:
        body_text = html_to_text("\n".join(html_parts))
    capped, truncated = truncate_body(body_text)
    return capped, attachments, truncated, attachments_truncated


def _open_imap(cfg: dict) -> imaplib.IMAP4_SSL:
    conn = imaplib.IMAP4_SSL(
        cfg["imap_host"],
        cfg["imap_port"],
        timeout=NETWORK_TIMEOUT_SECONDS,
        ssl_context=ssl.create_default_context(),
    )
    conn.login(cfg["user"], cfg["password"])
    if "UTF8=ACCEPT" in getattr(conn, "capabilities", ()):
        try:
            conn.enable("UTF8=ACCEPT")
        except imaplib.IMAP4.error:
            pass
    return conn


def _parse_list_entry(raw_line: bytes | str) -> dict | None:
    line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line)
    match = _LIST_LINE_RE.match(line.strip())
    if not match:
        return None
    flags = [flag.strip() for flag in match.group(1).split() if flag.strip()]
    name = match.group(2).strip()
    if name.startswith('"') and name.endswith('"') and len(name) >= 2:
        name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return {"name": name, "flags": flags}


def _list_folders_from_conn(conn: imaplib.IMAP4_SSL) -> list[dict]:
    status, data = conn.list()
    if status != "OK" or not data:
        return []
    folders = []
    for item in data:
        if isinstance(item, tuple):
            item = item[0]
        parsed = _parse_list_entry(item)
        if parsed:
            folders.append(parsed)
    return folders


def _select_mailbox(conn: imaplib.IMAP4_SSL, folder: str, *, readonly: bool = True):
    clean = (folder or "INBOX").strip() or "INBOX"
    status, data = conn.select(_quote_imap(clean), readonly=readonly)
    if status != "OK":
        detail = data[0].decode("utf-8", errors="replace") if data and isinstance(data[0], bytes) else str(data)
        raise ValueError(f"No se pudo abrir la carpeta '{clean}': {detail}")


def _validate_uid(raw_uid) -> str:
    uid = str(raw_uid or "").strip()
    if not _UID_RE.fullmatch(uid):
        raise ValueError("El parámetro 'uid' debe ser un número entero positivo.")
    return uid


def _build_search_criteria(args: dict) -> list[str]:
    criteria: list[str] = []
    if args.get("unseen_only") is True:
        criteria.append("UNSEEN")
    since_days = args.get("since_days")
    if since_days is not None:
        if isinstance(since_days, bool) or not isinstance(since_days, int) or since_days < 1 or since_days > 3650:
            raise ValueError("'since_days' debe ser un entero entre 1 y 3650.")
        since_dt = datetime.date.today() - datetime.timedelta(days=since_days)
        # IMAP SINCE exige meses en inglés abreviados (DD-Mon-YYYY) independientemente del locale.
        months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
        criteria.extend(["SINCE", f"{since_dt.day:02d}-{months[since_dt.month - 1]}-{since_dt.year}"])
    for arg_name, imap_key in (("from_addr", "FROM"), ("subject", "SUBJECT"), ("query", "TEXT")):
        val = args.get(arg_name)
        if isinstance(val, str) and val.strip():
            criteria.extend([imap_key, _quote_imap(val.strip())])
    return criteria or ["ALL"]


def _parse_header_summary(uid: str, flags_raw: bytes, header_bytes: bytes) -> dict:
    msg = email.message_from_bytes(header_bytes, policy=email.policy.compat32)
    flags_text = flags_raw.decode("utf-8", errors="replace")
    return {
        "uid": uid,
        "from": _decode_mime_header(msg.get("From")),
        "subject": _decode_mime_header(msg.get("Subject")),
        "date": _decode_mime_header(msg.get("Date")),
        "seen": "\\Seen" in flags_text,
    }


def _header_value_safe(value: str, field_name: str) -> str:
    clean = str(value).strip()
    if "\r" in clean or "\n" in clean:
        raise ValueError(f"La cabecera '{field_name}' no puede contener saltos de línea.")
    return clean


def _normalize_recipients(raw, field_name: str) -> str:
    if isinstance(raw, list):
        items = [_header_value_safe(item, field_name) for item in raw if isinstance(item, str) and item.strip()]
        joined = ", ".join(items)
    elif isinstance(raw, str):
        joined = _header_value_safe(raw, field_name)
    else:
        joined = ""
    if not joined and field_name == "to":
        raise ValueError("Falta al menos un destinatario en 'to'.")
    return joined


def ensure_outbox() -> Path:
    """Crea la carpeta de salida (solo para el usuario) y comprueba que no es un enlace a otra parte."""
    OUTBOX_DIR.mkdir(mode=0o700, exist_ok=True)
    if OUTBOX_DIR.is_symlink() or not OUTBOX_DIR.is_dir():
        raise ValueError(f"La carpeta de salida {OUTBOX_DIR} no es un directorio normal.")
    return OUTBOX_DIR


def _outbox_file_name(raw) -> str:
    name = raw.strip() if isinstance(raw, str) else ""
    if (not name or name in (".", "..") or len(name) > 255
            or any(ch in name for ch in ("/", "\\", ":", "\0"))):
        raise ValueError(f"Adjunto no válido: {raw!r}. Indica solo el nombre de un fichero de {OUTBOX_DIR}, sin ruta.")
    return name


def _read_outbox_file(path: Path, max_bytes: int) -> bytes:
    """Lee un fichero normal de la carpeta de salida sin seguir enlaces; falla si supera max_bytes."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise ValueError(f"No existe '{path.name}' en {OUTBOX_DIR}: cópialo antes allí.") from None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"'{path.name}' no es un fichero normal (no se admiten enlaces ni carpetas).")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(fd, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError(f"'{path.name}' no es un fichero normal.")
        data = handle.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError(f"Los adjuntos superan el máximo de {MAX_OUTGOING_ATTACHMENT_BYTES} bytes en total.")
    return data


def _load_outbox_attachments(raw) -> list[tuple[Path, bytes]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        raise ValueError("'attachments' debe ser una lista de nombres de fichero.")
    if len(raw) > MAX_OUTGOING_ATTACHMENTS:
        raise ValueError(f"Como máximo {MAX_OUTGOING_ATTACHMENTS} adjuntos por mensaje.")
    names = [_outbox_file_name(item) for item in raw]
    if len(set(names)) != len(names):
        raise ValueError("Hay adjuntos repetidos en 'attachments'.")
    outbox = ensure_outbox()
    loaded: list[tuple[Path, bytes]] = []
    remaining = MAX_OUTGOING_ATTACHMENT_BYTES
    for name in names:
        data = _read_outbox_file(outbox / name, remaining)
        remaining -= len(data)
        loaded.append((outbox / name, data))
    return loaded


def _remove_attachments(paths: list[Path]) -> list[str]:
    """Borra los adjuntos ya enviados o guardados; devuelve los nombres que no se pudieron borrar."""
    not_removed = []
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            not_removed.append(path.name)
    return not_removed


def _attachment_result(paths: list[Path]) -> dict:
    if not paths:
        return {}
    result: dict = {"attachments": [path.name for path in paths]}
    not_removed = _remove_attachments(paths)
    if not_removed:
        result["attachments_not_removed"] = not_removed
    return result


def _build_email_message(conn: imaplib.IMAP4_SSL | None, cfg: dict,
                         args: dict) -> tuple[email.message.EmailMessage, list[Path]]:
    """Compone el mensaje con sus adjuntos de la carpeta de salida; devuelve también sus rutas para borrarlas."""
    to_header = _normalize_recipients(args.get("to"), "to")
    cc_header = _normalize_recipients(args.get("cc"), "cc") if args.get("cc") else ""
    subject = _header_value_safe(args.get("subject") or "", "subject")
    if not subject:
        raise ValueError("El asunto ('subject') no puede estar vacío.")
    body = args.get("body")
    if not isinstance(body, str) or not body.strip():
        raise ValueError("El cuerpo ('body') no puede estar vacío.")
    attachments = _load_outbox_attachments(args.get("attachments"))

    msg = email.message.EmailMessage()
    msg["From"] = cfg["user"]
    msg["To"] = to_header
    if cc_header:
        msg["Cc"] = cc_header
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    # Con el dominio del remitente: sin él, make_msgid llama a socket.getfqdn, que puede tardar decenas de segundos.
    msg["Message-ID"] = email.utils.make_msgid(domain=str(cfg["user"]).rpartition("@")[2] or "localhost")

    reply_to_uid = args.get("reply_to_uid")
    if reply_to_uid is not None and str(reply_to_uid).strip():
        if conn is None:
            conn = _open_imap(cfg)
            close_here = True
        else:
            close_here = False
        try:
            _select_mailbox(conn, str(args.get("reply_folder") or "INBOX"), readonly=True)
            uid = _validate_uid(reply_to_uid)
            status, fetched = conn.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID REFERENCES)])")
            if status == "OK" and fetched and isinstance(fetched[0], tuple):
                orig = email.message_from_bytes(fetched[0][1], policy=email.policy.compat32)
                orig_id = (orig.get("Message-ID") or "").strip()
                orig_refs = (orig.get("References") or "").strip()
                if orig_id:
                    msg["In-Reply-To"] = orig_id
                    msg["References"] = f"{orig_refs} {orig_id}".strip()
        finally:
            if close_here:
                conn.logout()

    msg.set_content(body)
    for path, data in attachments:
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        maintype, _, subtype = content_type.partition("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=path.name)
    return msg, [path for path, _ in attachments]


def _find_drafts_folder(conn: imaplib.IMAP4_SSL) -> str:
    folders = _list_folders_from_conn(conn)
    for item in folders:
        if any(flag.lower() == "\\drafts" for flag in item["flags"]):
            return item["name"]
    for candidate in ("[Gmail]/Drafts", "[Gmail]/Borradores", "Drafts"):
        if any(item["name"].lower() == candidate.lower() for item in folders):
            return next(item["name"] for item in folders if item["name"].lower() == candidate.lower())
    return "Drafts"


def tool_list_folders(cfg: dict, _args: dict) -> dict:
    conn = _open_imap(cfg)
    try:
        return {"folders": _list_folders_from_conn(conn)}
    finally:
        conn.logout()


def tool_search_messages(cfg: dict, args: dict) -> dict:
    folder = str(args.get("folder") or "INBOX").strip() or "INBOX"
    limit = args.get("limit", DEFAULT_SEARCH_LIMIT)
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1 or limit > MAX_SEARCH_LIMIT:
        raise ValueError(f"'limit' debe ser un entero entre 1 y {MAX_SEARCH_LIMIT}.")
    criteria = _build_search_criteria(args)
    use_utf8 = any(not item.isascii() for item in criteria)

    conn = _open_imap(cfg)
    try:
        _select_mailbox(conn, folder, readonly=True)
        if use_utf8 and not getattr(conn, "utf8_enabled", False):
            status, data = conn.uid("SEARCH", "CHARSET", "UTF-8", *(item.encode("utf-8") for item in criteria))
        else:
            status, data = conn.uid("SEARCH", *criteria)
        if status != "OK":
            raise ValueError("Error al buscar mensajes en IMAP.")
        raw_uids = (data[0] or b"").decode("ascii", errors="ignore").split()
        selected_uids = list(reversed(raw_uids[-limit:]))
        if not selected_uids:
            return {"folder": folder, "total_matched": 0, "messages": []}

        uid_set = ",".join(selected_uids)
        status, fetched = conn.uid("FETCH", uid_set, "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
        if status != "OK":
            raise ValueError("Error al obtener las cabeceras de los mensajes.")
        by_uid: dict[str, dict] = {}
        for item in fetched or []:
            if not isinstance(item, tuple) or len(item) < 2:
                continue
            meta = item[0].decode("utf-8", errors="replace")
            uid_match = re.search(r"\bUID\s+(\d+)", meta)
            if uid_match:
                uid = uid_match.group(1)
                by_uid[uid] = _parse_header_summary(uid, item[0], item[1])
        messages = [by_uid[uid] for uid in selected_uids if uid in by_uid]
        return {"folder": folder, "total_matched": len(raw_uids), "messages": messages}
    finally:
        conn.logout()


def tool_read_message(cfg: dict, args: dict) -> dict:
    folder = str(args.get("folder") or "INBOX").strip() or "INBOX"
    uid = _validate_uid(args.get("uid"))
    mark_seen = args.get("mark_seen") is True

    conn = _open_imap(cfg)
    try:
        _select_mailbox(conn, folder, readonly=not mark_seen)
        fetch_item = "(BODY[])" if mark_seen else "(BODY.PEEK[])"
        status, fetched = conn.uid("FETCH", uid, fetch_item)
        if status != "OK" or not fetched or not isinstance(fetched[0], tuple):
            raise ValueError(f"Mensaje con UID {uid} no encontrado en '{folder}'.")
        msg = email.message_from_bytes(fetched[0][1], policy=email.policy.compat32)
        body, attachments, truncated, attachments_truncated = _extract_body_and_attachments(msg)
        return {
            "uid": uid,
            "folder": folder,
            "from": _decode_mime_header(msg.get("From")),
            "to": _decode_mime_header(msg.get("To")),
            "cc": _decode_mime_header(msg.get("Cc")),
            "date": _decode_mime_header(msg.get("Date")),
            "subject": _decode_mime_header(msg.get("Subject")),
            "message_id": (msg.get("Message-ID") or "").strip(),
            "attachments": attachments,
            "attachments_truncated": attachments_truncated,
            "body": body,
            "truncated": truncated,
        }
    finally:
        conn.logout()


def tool_create_draft(cfg: dict, args: dict) -> dict:
    conn = _open_imap(cfg)
    try:
        msg, attachment_paths = _build_email_message(conn, cfg, args)
        drafts_folder = _find_drafts_folder(conn)
        internal_date = imaplib.Time2Internaldate(time.time())
        status, _ = conn.append(_quote_imap(drafts_folder), "\\Draft \\Seen", internal_date, msg.as_bytes())
        if status != "OK":
            raise ValueError(f"No se pudo guardar el borrador en '{drafts_folder}'.")
        return {
            "saved": True,
            "folder": drafts_folder,
            "to": msg["To"],
            "subject": msg["Subject"],
            "message_id": msg["Message-ID"],
            **_attachment_result(attachment_paths),
        }
    finally:
        conn.logout()


def tool_send_email(cfg: dict, args: dict) -> dict:
    msg, attachment_paths = _build_email_message(None, cfg, args)
    ctx = ssl.create_default_context()
    port = cfg["smtp_port"]
    if port == 587:
        with smtplib.SMTP(cfg["smtp_host"], port, timeout=NETWORK_TIMEOUT_SECONDS) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ctx)
            smtp.ehlo()
            smtp.login(cfg["user"], cfg["password"])
            smtp.send_message(msg)
    else:
        with smtplib.SMTP_SSL(cfg["smtp_host"], port, timeout=NETWORK_TIMEOUT_SECONDS, context=ctx) as smtp:
            smtp.login(cfg["user"], cfg["password"])
            smtp.send_message(msg)
    return {
        "sent": True,
        "to": msg["To"],
        "cc": msg.get("Cc", ""),
        "subject": msg["Subject"],
        "message_id": msg["Message-ID"],
        **_attachment_result(attachment_paths),
    }


_COMPOSE_SCHEMA = {
    "type": "object",
    "properties": {
        "to": {"type": "string", "description": "Recipient email address (or comma-separated list)"},
        "subject": {"type": "string", "description": "Email subject"},
        "body": {"type": "string", "description": "Plain-text message body"},
        "cc": {"type": "string", "description": "Optional CC recipients"},
        "reply_to_uid": {"type": "string", "description": "Optional UID of the message being replied to (sets threading headers)"},
        "reply_folder": {"type": "string", "description": "Folder containing reply_to_uid (defaults to 'INBOX')", "default": "INBOX"},
        "attachments": {
            "type": "array",
            "items": {"type": "string"},
            "description": (f"Optional file names (no path) to attach, taken from the outbox folder {OUTBOX_DIR}. "
                            f"Up to {MAX_OUTGOING_ATTACHMENTS} files and {MAX_OUTGOING_ATTACHMENT_BYTES // (1024 * 1024)} MB in total."),
        },
    },
    "required": ["to", "subject", "body"],
}

TOOLS_DEFINITIONS = [
    {
        "name": "list_folders",
        "description": "List IMAP mailbox folders and their flags (e.g. INBOX, Drafts, Sent).",
        "annotations": {"readOnlyHint": True},
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "search_messages",
        "description": "Search messages in an IMAP folder without marking them as read. Returns newest matches first (headers and UID only).",
        "annotations": {"readOnlyHint": True},
        "inputSchema": {
            "type": "object",
            "properties": {
                "folder": {"type": "string", "description": "IMAP folder name (defaults to 'INBOX')", "default": "INBOX"},
                "query": {"type": "string", "description": "Text to match across message content and headers"},
                "from_addr": {"type": "string", "description": "Filter by sender address or name"},
                "subject": {"type": "string", "description": "Filter by subject text"},
                "since_days": {"type": "integer", "description": "Only messages from the last N days (1-3650)"},
                "unseen_only": {"type": "boolean", "description": "Only unread messages", "default": False},
                "limit": {"type": "integer", "description": f"Maximum messages to return (1-{MAX_SEARCH_LIMIT}, default {DEFAULT_SEARCH_LIMIT})", "default": DEFAULT_SEARCH_LIMIT},
            },
        },
    },
    {
        "name": "read_message",
        "description": "Read an email message by UID (headers, plain-text body capped at 16000 chars, and attachment metadata).",
        "annotations": {"readOnlyHint": True},
        "inputSchema": {
            "type": "object",
            "properties": {
                "uid": {"type": "string", "description": "Message UID returned by search_messages"},
                "folder": {"type": "string", "description": "IMAP folder name (defaults to 'INBOX')", "default": "INBOX"},
                "mark_seen": {"type": "boolean", "description": "Mark the message as read (defaults to false)", "default": False},
            },
            "required": ["uid"],
        },
    },
    {
        "name": "create_draft",
        "description": ("Save an email draft in the IMAP Drafts folder without sending it. "
                        f"To attach files, first copy them into {OUTBOX_DIR} (for example with run_command) and pass "
                        "their file names in 'attachments'; they are deleted from that folder once the draft is saved."),
        "inputSchema": _COMPOSE_SCHEMA,
    },
    {
        "name": "send_email",
        "description": ("Send an email immediately via SMTP. "
                        f"To attach files, first copy them into {OUTBOX_DIR} (for example with run_command) and pass "
                        "their file names in 'attachments'; they are deleted from that folder once the email is sent."),
        "inputSchema": _COMPOSE_SCHEMA,
    },
]

TOOL_HANDLERS = {
    "list_folders": tool_list_folders,
    "search_messages": tool_search_messages,
    "read_message": tool_read_message,
    "create_draft": tool_create_draft,
    "send_email": tool_send_email,
}


def reply(req_id, result=None, error=None):
    resp = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        resp["error"] = error
    else:
        resp["result"] = result
    sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle_request(req: dict):
    req_id = req.get("id")
    if req_id is None:
        return
    method = req.get("method")
    params = req.get("params") if isinstance(req.get("params"), dict) else {}

    if method == "initialize":
        reply(req_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "capabilities": {"tools": {}},
        })
        return
    if method == "tools/list":
        reply(req_id, {"tools": TOOLS_DEFINITIONS})
        return
    if method == "tools/call":
        name = params.get("name")
        handler = TOOL_HANDLERS.get(name)
        if handler is None:
            reply(req_id, error={"code": -32601, "message": f"Tool not found: {name}"})
            return
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        try:
            cfg = parse_mail_config()
            payload = handler(cfg, args)
            reply(req_id, {
                "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
                "isError": False,
            })
        except Exception as exc:
            reply(req_id, {
                "content": [{"type": "text", "text": str(exc)}],
                "isError": True,
            })
        return
    reply(req_id, error={"code": -32601, "message": f"Method not found: {method}"})


def main():
    ensure_outbox()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(req, dict):
            handle_request(req)


if __name__ == "__main__":
    main()
