# M61 Integridad del sistema de permisos

Auditoría del sistema de permisos posterior a M60 y especificación de las tareas del hito M61.
Las tareas de `.zerochat/plan.md` ocupan una línea cada una; su alcance, sus cambios, sus pruebas y su criterio de aceptación están aquí.

## Hallazgos

Los marcados con ✅ se reprodujeron contra el backend real (2026-11-11).

| ID | Gravedad | Hallazgo | Tarea |
|---|---|---|---|
| C1 ✅ | Crítica | `tools/call` con un `challengeId` autorizado omite la evaluación sin comprobar herramienta ni argumentos. Con `allow_session`/`allow_always` el reto no se retira y puede reutilizarse; la caducidad solo se aplica al crear otro reto. Ningún sitio del frontend envía `challengeId` a `tools/call`. | T1, T2 |
| C2 ✅ | Crítica | El backend evalúa con `server_id` igual a `"external"` o `"mcp-proxy"`. Confiar en `playwright` desde Ajustes no tiene efecto, y «Permitir servidor» en una herramienta local autoriza todas las locales, `run_command` incluido. El frontend no envía `serverId`, y el backend lo descartaría. | T3 |
| C3 ✅ | Alta | «Permitir siempre» genérico en `run_command` guarda la herramienta sin `constraints`: aceptar `ls` permite después cualquier comando. | T4 |
| C4 | Alta | Las reglas de directorio comparan texto normalizado sin resolver enlaces simbólicos (`/proj/link → /etc` cumple `RW:/proj/**`), mientras que `workspace_trust` sí usa `resolve()`. | T5 |
| S1 ✅ | Alta | `import_state` no carga antes el estado guardado; la primera lectura posterior carga SQLite y pisa lo importado. Por eso se pierde el `tool_security` de las ejecuciones en servidor. | T7, T8 |
| S2 ✅ | Media | `import_state` no es atómico: aplica `globalMcpPolicy` y después falla en `directoryRules`. | T6 |
| S3 ✅ | Media | `save_to_storage` solo registra `sqlite3.Error` en modo depuración y la RPC responde que todo fue bien; `OSError` sí se propaga. La memoria queda desincronizada de la BD. | T6 |
| S4 | Media | El frontend mantiene una segunda persistencia (`localStorage`) y cada `save()` envía su estado completo al backend, de modo que gana la última escritura. Cada proceso (servidor y ejecuciones en servidor) cachea el estado una sola vez. | T7, T10, T11 |
| S5 | Media | `import_state` no valida las entradas de `tools`/`servers`. Los permisos de sesión que llegan con `tool_security` entran como permanentes. | T6, T8 |
| S6 | Media | `hydrateToolSecurity` usa setters que persisten: la política de una ejecución puntual se vuelve permanente. | T8 |
| D1 ✅ | Alta | La regla por defecto `RW:<cwd>/**` se calcula mientras no hay reglas, pero `export_state` la devuelve y cualquier `get → update` o `add_directory_rule` la persiste. Al cambiar de proyecto todo pide confirmación. | T9 |
| D2 | Media | El frontend usa `R:<cwd>` y el backend `RW:<cwd>/**`; `setStartupDirectory` nunca reemplaza la regla del backend y la reenvía en el siguiente `save()`. | T9, T11, T12 |
| D3 | Baja | En la reconexión, `setStartupDirectory` puede ejecutar `syncToBackend` con el cliente anterior antes de `syncFromBackend`. | T11 |
| D4 | Media | `set_project_directory` no afecta a los retos pendientes: un reto con rutas relativas aprobado en A se ejecuta en B. | T2 |
| Q1 | Baja | Duplicaciones: tres rutas de ejecución con parseo de errores copiado; serialización duplicada en `tool-security.js`; utilidades de rutas en JS y Python que no coinciden; `SERVER_POLICY_*` igual a `TOOL_POLICY_*`; `set/get/revoke` de herramienta y de servidor casi idénticos. | T1, T11, T12, T13 |
| Q2 | Baja | Código muerto o especulativo: `getAgentCore` y el parámetro `tool` de `findToolEntry` en `tool-security.js`; `elif allow_once: pass`; `policy_id`/`user_id`; `SecurityContext.user_id/session_id`; `globals().get(...)`; cabecera de `tool-security.js` desactualizada; `findServerEntry` sin distinguir mayúsculas frente al backend, que sí distingue. | T7, T11, T13 |

## Decisiones de diseño

1. **Un reto equivale a una ejecución.** Solo `zerochat/security/authorize` ejecuta un reto, siempre con la herramienta y los argumentos guardados, y lo consume sea cual sea la decisión. `tools/call` no acepta `challengeId`. Si el usuario elige `allow_session` o `allow_always`, las llamadas siguientes pasan por la política registrada, no por el reto. (T1, T2)
2. **La identidad del servidor la fija el backend.** En herramientas externas se obtiene del servicio propietario del nombre público. Las herramientas locales no tienen servidor de confianza. `allow_server_always` confía en el servidor del reto y nunca lee un `serverId` enviado por el cliente. (T3)
3. **`run_command` solo se autoriza «siempre» con restricciones.** Sin `constraints`, `allow_always` se rechaza. Para confiar sin límites quedan la política global `allow_all` o el selector explícito de Ajustes → MCP. (T4)
4. **Las reglas de directorio se comparan sobre rutas reales,** tanto el destino como la base de la regla, igual que `workspace_trust`. (T5)
5. **SQLite es la única fuente del estado permanente.** El `AccessController` no lo cachea: lo lee en cada operación y escribe con lectura-modificación-escritura dentro de una transacción. En memoria solo quedan los permisos de sesión y los retos. (T7)
6. **Las actualizaciones son atómicas y validadas.** Se valida el payload completo antes de aplicar nada, y un error de persistencia llega a la RPC como error. (T6)
7. **El `tool_security` de una ejecución en servidor es una capa de sesión,** solo en memoria y nunca persistida. (T8)
8. **La regla del proyecto es dinámica.** `RW:<cwd>/**` se calcula en cada evaluación y siempre se aplica. Nunca se persiste. Se expone aparte (`defaultDirectoryRule`) de las reglas del usuario (`directoryRules`). (T9)
9. **El frontend es una caché del backend.** No usa `localStorage` para permisos, cada cambio es un parche (`security/update` con claves parciales y `null` para revocar) y adopta el estado que devuelve la respuesta. (T10, T11)

10. **Sin migración.** El usuario borra el directorio de datos de ZeroChat para partir de un estado limpio; no se añade código de compatibilidad con políticas antiguas (AGENTS.md §2).

Confirmadas por el usuario el 2026-11-11 y registradas en `.zerochat/log.md` como M61-D1 a M61-D10.

## Tareas

Orden de ejecución: T1 → T13. Cada tarea deja todos los niveles de §4 de AGENTS.md en verde y, si toca `py/`, recompila con `npm run build:backend`.

### M61-T1 Punto único de ejecución de herramientas en el servidor
- **Cambios:**
  - En `ff-server.py`, añadir `_execute_tool(origin, tool_name, args)` con `origin ∈ {"local", "external"}`. Ejecuta el manejador local o `GLOBAL_MCP_MANAGER.call` y normaliza el resultado a `(result, error, tool_error_info)`.
  - Añadir `_authorize_or_challenge(origin, tool_name, args, ctx)`, que hace evaluar → deny → reto.
  - `tools/call` local, `tools/call` externo y `security/authorize` con ejecución usan estas dos funciones; desaparecen los tres bloques duplicados.
  - El reto guarda `origin`. `authorize` elige la ruta por `origin`, no buscando el nombre en `LOCAL_TOOL_HANDLERS`.
- **Pruebas** (`tests/infrastructure/py/test_security.py`): un reto creado en `/mcp/external` se ejecuta por la ruta externa aunque su nombre coincida con el de un manejador local (con `GLOBAL_MCP_MANAGER.call` simulado).
- **Aceptación:** una sola función invoca manejadores de herramientas en `ff-server.py` (se comprueba con `grep "handler(**"`).

### M61-T2 Reto ligado a una sola ejecución
- **Cambios:**
  - Retirar la lectura de `challengeId` y `_meta.challengeId` en `tools/call` (local y externo).
  - En el frontend, retirar `challengeId` de `McpClient.callTool` (`mcp.js:293`), del `execute` de la herramienta MCP (`mcp.js:432`) y de `executeToolCall` (`agent-core.js:286`).
  - `security/authorize` con decisión distinta de `deny` registra la decisión y **siempre** ejecuta el reto guardado. `execute` deja de ser opcional y se retira de `authorizeChallenge`.
  - `consume_challenge` retira el reto siempre y rechaza los caducados.
  - El reto guarda el `cwd` de creación, y `authorize` lo rechaza si `Path.cwd()` ha cambiado (D4).
- **Pruebas:**
  - Un `tools/call` con `challengeId` vuelve a evaluarse y emite un reto nuevo.
  - Un reto no se ejecuta dos veces.
  - Caducidad en el borde exacto: se acepta a 600 000 ms y se rechaza a 600 001 ms, con reloj simulado.
  - Un cambio de directorio entre reto y autorización hace que se rechace.
  - Hay que adaptar `test_challenge_creation_and_authorize_rpc`.
- **Aceptación:** el probe C1 ya no escribe el fichero.

### M61-T3 Identidad real del servidor en las autorizaciones
- **Cambios:**
  - Nuevo `McpServiceManager.server_of(public_name) -> str | None` en `ee-mcp.py`. `_dispatch_external` pasa ese `server_id` a `evaluate_authorization` y a `create_challenge`.
  - En herramientas locales, `server_id` vacío: no se consultan políticas de servidor y `rule_offer` no ofrece confianza de servidor.
  - `record_decision` usa solo `challenge["serverId"]` y rechaza `allow_server_always` si está vacío.
  - En el frontend, `tool-cards.js` no muestra el botón de servidor en herramientas del proxy local (`mcpServerId === 'mcp_proxy'`), y la decisión deja de llevar `serverId`.
- **Pruebas:**
  - Confiar en `playwright` permite `playwright__x` y no `otro__y`.
  - `allow_server_always` sobre una herramienta local se rechaza y no añade servidores.
  - Prueba de navegador: el botón de servidor no aparece en una herramienta local.
- **Aceptación:** los probes de C2 (Ajustes → confiar y tarjeta local) se comportan como se espera.

### M61-T4 «Permitir siempre» acotado en run_command
- **Cambios:**
  - En `authorize_challenge`, si la herramienta es `COMMAND_TOOL` y `allow_always` llega sin `constraints.command`, se devuelve el error -32602 `allow_always_requires_command_pattern` y el reto sigue pendiente.
  - `tool-cards.js` oculta el botón genérico «Permitir siempre» cuando `ruleOffer.type === 'command'`; queda el botón «Permitir `cmd *`».
- **Pruebas:**
  - `allow_always` sin restricciones en `run_command` se rechaza.
  - Con restricciones, solo se permite el prefijo concedido.
  - Prueba de navegador del botón oculto.
- **Aceptación:** el probe C3 pide confirmación para `rm -rf /`.

### M61-T5 Reglas de directorio sobre rutas reales
- **Cambios:**
  - `evaluate_directory_rule` resuelve el destino con `Path(...).resolve(strict=False)` relativo a `ctx.workspace_dir`, y la base fija de cada regla (la parte anterior al primer `*`) con `os.path.realpath`. La comparación se hace solo sobre las rutas resueltas.
  - Se retira la doble comparación con `resolved_absolute`. `workspace_trust` y las reglas comparten el mismo resolutor (`SecurityContext.resolve_path`).
- **Pruebas:**
  - Un enlace dentro del proyecto que apunta fuera pide confirmación.
  - Una regla cuya base es un enlace (`/link/** → /real`) sigue permitiendo `/real/x` y `/link/x`.
  - Una ruta relativa con `..` que sale del proyecto pide confirmación.
- **Aceptación:** variantes simétricas según §6 de AGENTS.md.

### M61-T6 Actualización de políticas atómica, validada y con errores visibles
- **Cambios:**
  - `import_state` valida todo antes de aplicar nada:
    - `globalMcpPolicy ∈ GLOBAL_POLICIES`;
    - reglas parseables;
    - cada entrada de `tools`/`servers` con `policy ∈ {allow, deny}`, `scope` forzado a `permanent` y `constraints` dict o `None`;
    - tope de tamaño del payload (número de entradas).
  - `save_to_storage` deja de capturar errores. La RPC `security/*` devuelve -32603 con el motivo, y el estado en memoria no cambia si falla la escritura.
- **Pruebas:**
  - Un payload con una regla inválida deja el estado intacto.
  - Una entrada con `policy` inválida se rechaza.
  - Un fallo de `save_security_policy_data` simulado devuelve error RPC y no cambia el estado.
  - El tope de entradas se prueba en `N` y `N+1`.
- **Aceptación:** los probes S2 y S3 se comportan como se espera.

### M61-T7 AccessController sin caché del estado permanente
- **Cambios:**
  - Retirar `_loaded`, `_ensure_loaded`, `load_from_storage` y la búsqueda con `globals().get(...)`.
  - Las lecturas (`evaluate_authorization`, `export_state`, `get_*_policy`) leen la fila de `security_policies` en cada llamada.
  - Las mutaciones (`set/revoke_*`, `set_directory_rules`, `record_decision`, `import_state`) hacen lectura-modificación-escritura en una transacción `BEGIN IMMEDIATE` de `ee-storage.py`, con una nueva función `update_security_policy_data(mutator)`.
  - En memoria solo quedan `session_tools`, `session_servers` y `pending_challenges`.
  - Se retiran `policy_id`/`user_id` de `get/save_security_policy_data` y de `load/save_to_storage`, y `user_id`/`session_id` de `SecurityContext` y de `_dispatch_security`.
- **Pruebas:**
  - Dos instancias de `AccessController` ven sus escrituras mutuas (simula servidor y ejecución en servidor).
  - El probe S1: un import seguido de una evaluación conserva lo importado.
- **Aceptación:** no hay estado permanente en atributos del controlador.

### M61-T8 tool_security de ejecuciones en servidor como capa de sesión
- **Cambios:**
  - Nuevo `AccessController.apply_session_overlay(state)`: valida como `import_state` y vuelca herramientas y servidores en `session_*`. La política global y las reglas de directorio de la ejecución quedan en una capa de sesión (`session_global_policy`, `session_directory_rules`) que `evaluate_authorization` consulta antes que la permanente. Nunca se persiste.
  - `reset_session_credentials` usa esa función. `clear_session` limpia también la capa.
  - En el frontend, `hydrateToolSecurity` (`run-mode.js`) solo rellena la caché local sin persistir, o se retira si su único consumidor queda cubierto por el backend. Hay que comprobar los consumidores en `run-node.js`.
- **Pruebas:**
  - Con la BD poblada, la capa de una ejecución sobrevive a la primera evaluación y no aparece en `get_security_policy_data()`.
  - Adaptar `test_reset_session_credentials_with_run_session` para que use una BD con datos.
  - `test_run_mode.js`: hidratar no persiste.
- **Aceptación:** una ejecución puntual no cambia la política global guardada.

### M61-T9 Regla de directorio del proyecto dinámica
- **Cambios:**
  - `directory_rules` guarda solo las reglas del usuario y puede estar vacío.
  - `get_default_directory_rule(ctx)` se evalúa siempre, además de las del usuario.
  - `export_state` devuelve `directoryRules` (las del usuario) y `defaultDirectoryRule` (calculada, de solo lectura).
  - `set_directory_rules([])` guarda `[]`. `set_directory_rules`/`import_state` descartan una regla igual a la por defecto del contexto actual, para no congelarla.
  - Se retira el `or [default]` de `set_directory_rules` y de `get_directory_rules`.
- **Pruebas:**
  - Con contexto A se permite A; tras un `get → update` con contexto A, el contexto B permite B y no A.
  - Añadir una regla con `add_directory_rule` no persiste la regla por defecto.
  - El probe D1.
- **Aceptación:** al cambiar de proyecto, la lectura y la escritura en el nuevo proyecto no piden confirmación y el anterior deja de estar autorizado (salvo regla explícita).

### M61-T10 security/update como parche parcial
- **Cambios:**
  - `zerochat/security/update` acepta claves opcionales: `globalMcpPolicy`, `directoryRules` (lista completa de reglas del usuario), `tools: {id: entry | null}` y `servers: {id: entry | null}`. `null` revoca.
  - Se aplica de forma atómica (T6, T7) y devuelve el estado completo.
  - Se retira el reemplazo completo de `tools`/`servers` en `import_state`.
- **Pruebas:**
  - Un parche de una herramienta no borra otras escritas por otra instancia.
  - `null` revoca.
  - Una clave ausente no cambia nada.
- **Aceptación:** dos clientes que editan herramientas distintas no se pisan.

### M61-T11 ChatToolSecurity como caché del backend
- **Cambios** en `tool-security.js`:
  - Retirar `STORAGE_KEY`, `STORAGE_VERSION`, `load`, `save`, `syncToBackend`, `setStartupDirectory`, `getStartupDirectory`, `getDefaultDirectoryRule` y `getAgentCore`.
  - Un único `applyPolicies(policies)` (sustituye a `syncFromBackend` y a la deserialización duplicada) y un `refresh()` que pide `security/get`.
  - Los setters (`setToolPolicy`, `revokeToolPolicy`, `setServerPolicy`, `revokeServerPolicy`, `setGlobalMcpPolicy`, `setDirectoryRules`, `addDirectoryRule`, `clearAllAuthorizations`) pasan a ser `async`: envían un parche (T10) y adoptan la respuesta. Sin servidor conectado lanzan un error.
  - `findToolEntry` y `findServerEntry` pasan a búsquedas exactas; se retira el parámetro `tool`.
  - `authorizeChallenge` refresca siempre tras autorizar.
  - En `mcp.js`, retirar las llamadas a `setStartupDirectory` y refrescar las políticas tras `connectProxy` y tras `setProjectDirectory`.
  - Retirar la referencia `profile-repository.js → STORAGE_KEY` si queda huérfana, y el uso de `tool_security` en la exportación de perfiles si dependía de `localStorage`.
  - Actualizar la cabecera del módulo.
  - Adaptar los consumidores a los setters asíncronos: `ui-mcp.js`, `ui-settings.js`, `project-context.js:635` y `run-mode.js`.
- **Pruebas:** reescribir `tests/integration/test_tool_security.js` con un `mcpClient` simulado: un parche por mutación, adopción de la respuesta y error sin conexión. Retirar las pruebas de `load/save/localStorage`.
- **Aceptación:** `grep -rn "tool_security'" js` no encuentra persistencia local de permisos.

### M61-T12 Ajustes: regla del proyecto de solo lectura y sin utilidades de rutas en JS
- **Cambios:**
  - `ui-settings.js` muestra `defaultDirectoryRule` como línea fija no editable encima del área de reglas del usuario, y muestra el error de validación que devuelve el backend.
  - Retirar de `tool-security.js` `normalizeDirectoryPath`, `parseDirectoryRule`, `containsUnresolvedReference` y `DIRECTORY_RULE_PATTERN`: la validación vive solo en Python.
  - Claves i18n nuevas en español e inglés, y retirada de las huérfanas.
  - Actualizar `help/mcp.html` y `help/en/mcp.html` (reglas de directorio y confianza de servidor) y `help/run-mode.html` y su versión inglesa si describen la persistencia de `tool_security`.
- **Pruebas:** prueba de navegador: la regla del proyecto se muestra y cambia tras un cambio de directorio simulado; un error del backend se muestra en el formulario.
- **Aceptación:** sin duplicación JS/Python de utilidades de rutas.

### M61-T13 Limpieza del backend de permisos y documentación
- **Cambios:**
  - Unificar `SERVER_POLICY_*` con `TOOL_POLICY_*` (`POLICY_ALLOW/DENY/ASK`).
  - Un helper común `_set_policy(kind, id, ...)` / `_revoke_policy(kind, id)` para herramientas y servidores.
  - Retirar `elif allow_once: pass`, la lectura de `serverId` en `record_decision`, los campos de `AccessDecision` sin consumidor y `SecurityContext.resolve_path` si queda inlined.
  - Documentar el contrato de permisos (retos, ámbitos, regla dinámica, capa de sesión, parche) en `py/README.md` y `js/README.md`.
  - `npm run build:backend`.
- **Pruebas:** solo la suite existente; no se añaden pruebas de refactor.
- **Aceptación:** la lista de comprobación de §6 de AGENTS.md sobre el `git diff` del hito queda sin observaciones.

## Done when

Los probes C1–C3, S1–S3 y D1 se comportan como se espera y están cubiertos por pruebas en `test_security.py`. SQLite es la única persistencia de permisos y el frontend no guarda permisos en `localStorage`. Un solo punto ejecuta herramientas y un reto equivale a una ejecución. La regla del proyecto sigue al directorio actual. No hay utilidades de rutas duplicadas entre JS y Python. Todos los niveles de §4 de AGENTS.md pasan en verde.
