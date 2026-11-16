"""Ofuscación simple de los secretos que el backend guarda en SQLite (API keys de los perfiles del servidor).

No es cifrado: la clave sale de este código, así que cualquiera que lo tenga recupera el secreto. Evita que una
clave se lea al abrir la base de datos o al buscar texto en el disco; la protección real son los permisos 0600 de
la carpeta de datos del usuario (docs/M75-apikeys.md).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import secrets

OBFUSCATION_PREFIX = "zc1:"
_OBFUSCATION_KEY = b"ZeroChat backend secret obfuscation v1"
_OBFUSCATION_NONCE_BYTES = 16


def _obfuscation_keystream(nonce: bytes, length: int) -> bytes:
    blocks = (hashlib.sha256(_OBFUSCATION_KEY + nonce + counter.to_bytes(4, "big")).digest()
              for counter in range((length + 31) // 32))
    return b"".join(blocks)[:length]


def obfuscate_secret(value: str) -> str:
    """El secreto tal como se guarda; vacío si no hay secreto. Un nonce aleatorio hace distintas dos copias iguales."""
    if not value:
        return ""
    data = value.encode("utf-8")
    nonce = secrets.token_bytes(_OBFUSCATION_NONCE_BYTES)
    mixed = bytes(a ^ b for a, b in zip(data, _obfuscation_keystream(nonce, len(data)), strict=True))
    return OBFUSCATION_PREFIX + base64.b64encode(nonce + mixed).decode("ascii")


def reveal_secret(stored: str) -> str:
    """El secreto original de lo guardado con obfuscate_secret; vacío si no hay secreto."""
    if not stored:
        return ""
    if not stored.startswith(OBFUSCATION_PREFIX):
        raise ValueError("El secreto guardado no tiene un formato válido")
    try:
        raw = base64.b64decode(stored[len(OBFUSCATION_PREFIX):], validate=True)
    except binascii.Error as exc:
        raise ValueError("El secreto guardado no tiene un formato válido") from exc
    nonce, mixed = raw[:_OBFUSCATION_NONCE_BYTES], raw[_OBFUSCATION_NONCE_BYTES:]
    if len(nonce) != _OBFUSCATION_NONCE_BYTES:
        raise ValueError("El secreto guardado no tiene un formato válido")
    return bytes(a ^ b for a, b in zip(mixed, _obfuscation_keystream(nonce, len(mixed)), strict=True)).decode("utf-8")
