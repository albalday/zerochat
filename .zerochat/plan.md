# Plan

<!-- Hitos M1 a M77 archivados en .zerochat/archive/ -->

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora: closed 2026-11-20

## M80 Entorno de ejecución por proyecto: closed 2026-11-20

## M81 Propuestas de mejora: closed 2026-11-21

## M83 Esperas síncronas en lugar de sondeo (restos tras M81): closed 2026-11-21

## M84 ZeroChat como ejecutor para orquestadores de agentes: closed 2026-11-21

## M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20

Goal: que cada agente que trabaja en este repositorio traiga a .zerochat/ lo que solo guarda en su memoria privada.
Done when: el usuario confirma que todos los agentes que usa lo han hecho.
- [ ] M82-T1 Cada agente que lea esta tarea revisa su memoria privada de este proyecto frente al código y a .zerochat/, propone al usuario las tareas, decisiones y normas aún vigentes y no registradas (nunca secretos ni datos personales), las escribe una vez aprobadas y pregunta al usuario antes de marcar la tarea como hecha, porque otros agentes pueden faltar todavía

## M85 Secretos por proyecto y relleno seguro en navegador

Goal: permitir guardar secretos por proyecto en SQLite (ofuscados, nunca expuestos al modelo) y ofrecer una herramienta local para rellenar campos `input` y teclados virtuales en Playwright MCP sin que las credenciales viajen en el contexto ni queden en el historial.
Done when: el usuario puede gestionar los secretos del proyecto desde Ajustes (solo escritura) y un agente con Playwright MCP activo puede rellenar tanto `input` como teclados virtuales mediante el nombre del secreto sin exponer su valor, con todos los niveles de §4 en verde.
- [x] M85-T1 Almacenamiento y API RPC de secretos por proyecto (`py/storage/db.py`, `py/server/rpc.py`, `py/auth/tokens.py`): guardar, listar nombres (sin valores) y borrar secretos en SQLite (`project:<key>:<NOMBRE>`), borrarlos también en `delete_project_storage`, restringir los métodos de gestión a credenciales `local`/`remote` (nunca `runner`) y validar estrictamente el formato del nombre (2026-11-22)
- [ ] M85-T2 Herramienta local `browser_fill_secret` para `input` y teclado virtual (`py/tools/browser_secret.py`, `py/tools/registry.py`, `py/server/tool_calls.py`): disponible con Playwright MCP activo y sujeta a `BrowserLease` (`M62-D15`) y al motor de permisos; admite modalidad `input` (`ref` en `browser_type`) y modalidad `keypad` (mapa dígito/carácter -> `ref` o coordenadas `[x, y]` ejecutado con `browser_click` en orden), leyendo el secreto en memoria del servidor y devolviendo solo confirmación o error sin filtrar el valor
- [ ] M85-T3 Interfaz de secretos de proyecto en Ajustes y guía en plantilla de agentes (`js/ui-settings.js`, `js/mcp.js`, `js/i18n.js`, `templates/project/mode-agent.txt`): añadir, actualizar (solo escritura, campo `password`) y borrar secretos del proyecto activo con i18n ES/EN sincronizado, y documentar `browser_fill_secret` en la plantilla de desarrollo de agentes
