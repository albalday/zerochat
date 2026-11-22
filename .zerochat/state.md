# Current state
- Milestone: M85 Secretos por proyecto y relleno seguro en navegador
- Next task: M85-T2 Herramienta local `browser_fill_secret` para `input` y teclado virtual (`py/tools/browser_secret.py`, `py/tools/registry.py`, `py/server/tool_calls.py`): disponible con Playwright MCP activo y sujeta a `BrowserLease` (`M62-D15`) y al motor de permisos; admite modalidad `input` (`ref` en `browser_type`) y modalidad `keypad` (mapa dígito/carácter -> `ref` o coordenadas `[x, y]` ejecutado con `browser_click` en orden), leyendo el secreto en memoria del servidor y devolviendo solo confirmación o error sin filtrar el valor
- Also open: M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20 (M82-T1)
- Last closed: M84 ZeroChat como ejecutor para orquestadores de agentes (2026-11-21)
- Last updated: 2026-11-22
