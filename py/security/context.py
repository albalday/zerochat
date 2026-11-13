"""Proyecto de cada petición (SecurityContext): carpeta canónica, rutas resueltas contra ella y clave de su sesión."""

from __future__ import annotations

import dataclasses
import re
import urllib.parse
from pathlib import Path


# Proyecto por defecto: la carpeta de arranque, para las peticiones que no indican el suyo (la primera
# conexión de una pestaña, las ejecuciones en servidor). El proceso nunca cambia de directorio: cada
# petición recibe su proyecto en un SecurityContext.
PROJECT_DIR = Path.cwd().resolve()


def project_context() -> "SecurityContext":
    """Contexto del proyecto por defecto del servidor."""
    return SecurityContext(PROJECT_DIR)


# Código JSON-RPC de una petición cuyo proyecto (cabecera X-ZeroChat-Project) ya no existe.
PROJECT_GONE_CODE = -32003


class ProjectGoneError(ValueError):
    """La carpeta del proyecto de la pestaña ya no existe."""


def request_project_context(raw: str | None, *, fallback: bool) -> "SecurityContext":
    """
    Proyecto de una petición: la carpeta absoluta de la cabecera X-ZeroChat-Project (codificada como en
    una URL) o, sin cabecera, el proyecto por defecto. Una carpeta que ya no existe es un error, salvo con
    fallback (initialize), que devuelve el proyecto por defecto para que la pestaña sepa dónde está.
    """
    if not raw:
        return project_context()
    path = Path(urllib.parse.unquote(raw))
    if path.is_absolute() and path.is_dir():
        return SecurityContext(path.resolve())
    if fallback:
        return project_context()
    raise ProjectGoneError(f"La carpeta del proyecto de la pestaña ya no existe: {path}")


@dataclasses.dataclass
class SecurityContext:
    """Proyecto en el que actúa una petición: base de sus rutas relativas, de sus comandos y de sus permisos."""
    workspace_dir: Path

    @property
    def key(self) -> str:
        """Identificador estable del proyecto: la clave de sus sesiones, de sus patrones guardados y de sus comandos."""
        return normalize_directory_path(str(self.workspace_dir))

    def absolute(self, path: str) -> Path:
        """
        Ruta que una herramienta abre: la resuelta contra la carpeta del proyecto ('~' es la del usuario).
        Es la misma que evalúan los permisos (resolve_path): colapsa los '..' antes de seguir enlaces
        simbólicos, así 'enlace/../x' no se permite como una ruta y se abre como otra. ValueError si no es válida.
        """
        norm = normalize_directory_path(str(Path(str(path).strip()).expanduser()))
        if not norm:
            raise ValueError(f"Ruta no válida: '{path}'.")
        target = Path(norm)
        return (target if target.is_absolute() else self.workspace_dir / target).resolve()

    def resolve_path(self, path_str: str) -> Path | None:
        """La ruta de absolute() para evaluar permisos; None si no es válida o lleva referencias sin resolver ('~', '$VAR')."""
        if not isinstance(path_str, str) or contains_unresolved_reference(path_str):
            return None
        try:
            return self.absolute(path_str)
        except (ValueError, RuntimeError, OSError):
            return None

    def is_inside_workspace(self, path_str: str) -> bool:
        """Determina si la ruta reside estrictamente dentro del espacio de trabajo del contexto."""
        resolved = self.resolve_path(path_str)
        if resolved is None:
            return False
        try:
            resolved.relative_to(self.workspace_dir.resolve())
            return True
        except ValueError:
            return False


def contains_unresolved_reference(value: str) -> bool:
    """Detecta variables de entorno ($VAR, ${VAR}) o expansiones de usuario (~)."""
    if not isinstance(value, str):
        return False
    trimmed = value.strip()
    if not trimmed:
        return False
    if trimmed.startswith("~"):
        return True
    return bool(re.search(r"\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)", trimmed))


def normalize_directory_path(value: str) -> str:
    """Normaliza rutas posix/windows colapsando . y .. de forma determinista."""
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        return ""
    if contains_unresolved_reference(value):
        return ""
    trimmed = value.strip().replace("\\", "/")
    is_absolute = bool(re.match(r"^(/|[A-Za-z]:/?)", trimmed))
    parts = []
    for part in trimmed.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            else:
                return ""
        else:
            parts.append(part)
    prefix = "/" if trimmed.startswith("/") else ""
    joined = "/".join(parts)
    if is_absolute and not joined.startswith("/") and not re.match(r"^[A-Za-z]:", joined):
        joined = prefix + joined
    return joined or (prefix or ".")
