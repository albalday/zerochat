# ==============================================================================
# Servidor HTTP JSON-RPC 2.0 y SSE con Autenticación por Token
# ==============================================================================


def validate_local_tool_arguments(tool_name: str, arguments: dict) -> str | None:
    """Valida tipos y límites de las herramientas locales a partir de su definición canónica."""
    definition = next((item for item in LOCAL_TOOLS_DEFINITIONS if item["name"] == tool_name), None)
    if definition is None:
        return None

    schema = definition.get("inputSchema", {})
    properties = schema.get("properties", {})
    type_map = {"string": str, "integer": int, "boolean": bool}

    for name, value in arguments.items():
        prop = properties.get(name)
        if prop is None:
            return f"Argumento no permitido: {name}"
        expected_type_name = prop.get("type")
        expected_type = type_map.get(expected_type_name)
        if expected_type is None:
            return f"Tipo no admitido en la definición de '{name}': {expected_type_name}"
        if expected_type is bool:
            if not isinstance(value, bool):
                return f"Tipo inválido para '{name}'"
        else:
            if isinstance(value, bool) or not isinstance(value, expected_type):
                return f"Tipo inválido para '{name}'"
        max_length = prop.get("maxLength")
        if max_length is not None and len(value) > max_length:
            return f"'{name}' excede el tamaño máximo permitido"

    for name in schema.get("required", ()):
        if name not in arguments:
            return f"Falta el argumento obligatorio: {name}"

    if tool_name == "browser_action":
        if arguments.get("action") not in BROWSER_ACTIONS:
            return f"Acción de navegador no permitida: {arguments.get('action')}"

    return None

def sanitize_log_path(raw_path: str) -> str:
    """Oculta tokens de sesión o parámetros sensibles en la query string para logs seguros."""
    if not raw_path or "?" not in raw_path:
        return raw_path or "/"
    path, query = raw_path.split("?", 1)
    safe_query = re.sub(r'(token=)[^&]+', r'\1***', query, flags=re.IGNORECASE)
    return f"{path}?{safe_query}"


def is_allowed_origin(origin: str | None, require_origin: bool = False) -> bool:
    """Verifica si el origen CORS está autorizado."""
    if origin is None or origin == "null":
        return not require_origin
    origin_lower = origin.lower()
    if origin_lower == "https://albalday.github.io" or origin_lower.startswith("https://albalday.github.io/"):
        return True
    if origin_lower == "http://127.0.0.1" or origin_lower.startswith("http://127.0.0.1:"):
        return True
    if origin_lower == "http://localhost" or origin_lower.startswith("http://localhost:"):
        return True
    return False


