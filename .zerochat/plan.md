# Plan

<!-- Hitos M1 a M69 archivados en .zerochat/archive/ -->

## M70 Arreglos de run_command: closed 2026-11-14

## M71 Navegador de ficheros del proyecto: closed 2026-11-14

## M72 Catálogo de servicios MCP con versión independiente: closed 2026-11-16

## M73 Arreglos de seguridad: closed 2026-11-15

## M74 Arreglos multiplataforma de la 10.19.0: closed 2026-11-16

## M75 Arreglos menores: closed 2026-11-16

## M76 Ajustes de perfiles: closed 2026-11-17

## M77 Almacenamiento unificado y selector de perfiles: closed 2026-11-17

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora

Goal: Mejorar el navegador de ficheros del proyecto y el uso de chats sin proyecto con el backend conectado, y conservar las propuestas de mejora de usabilidad, funcionalidad y solidez para decidirlas una a una con el usuario.
Done when: las tareas del navegador de ficheros y de chats sin proyecto están hechas o descartadas, y cada propuesta está implementada o marcada como descartada con su motivo.
- [x] M79-T1 Navegador de ficheros: tamaño de letra ajustable en la vista de ficheros de texto (2026-11-18)
- [x] M79-T2 Navegador de ficheros: descargar cualquier fichero, también los de texto, además de abrirlo (2026-11-18)
- [x] M79-T3 Navegador de ficheros: decidir con el usuario si los .html se abren renderizados y cómo aislarlos del origen de la aplicación (dropped: no aporta suficiente valor frente a la vista de texto)
- [x] M79-T4 Navegador de ficheros: decidir con el usuario un editor pequeño de ficheros de texto con guardado por el backend sujeto a las reglas de directorio (dropped: editar ficheros se hace fácilmente pidiéndoselo al agente)
- [x] M79-T5 Navegador de ficheros: decidir con el usuario borrar ficheros con confirmación y sujeto a las reglas de directorio (dropped: borrar ficheros se hace fácilmente pidiéndoselo al agente)
- [x] M79-T6 Decidir con el usuario y permitir usar chats sin proyecto cuando hay conexión con el backend (2026-11-18)
- [x] M79-T7 Propuesta: buscar en el contenido de las conversaciones, no solo en el título (FTS5 en el servidor, IndexedDB sin él) (2026-11-18)
- [ ] M79-T8 Propuesta: regenerar una respuesta y editar una pregunta en su sitio creando rama automáticamente
- [ ] M79-T9 Propuesta: atajos de teclado (nueva conversación, buscar con Ctrl+K, detener con Esc, chuleta con ?)
- [ ] M79-T10 Propuesta: aviso en el título o el icono de la pestaña cuando un turno termina o pide permiso en segundo plano, sin la API Notification
- [ ] M79-T11 Propuesta: prompts guardados, globales o por proyecto, insertables con / en el compositor
- [ ] M79-T12 Propuesta: asistente de primer perfil con detección bajo petición de servidores locales y tabla de qué funciona en navegador y en servidor
- [ ] M79-T13 Propuesta: copia de seguridad y restauración del almacén del servidor (zerochat --backup y --restore)
- [ ] M79-T14 Propuesta: RAG híbrido opcional con /v1/embeddings del servidor de modelos fusionado con Orama
- [ ] M79-T15 Propuesta: batería de evaluación del agente con zerochat --prompt contra modelos locales, sin ajustes por modelo
- [ ] M79-T16 Propuesta: control de concurrencia entre pestañas con versión por conversación y 409 al guardar sobre una versión antigua
- [ ] M79-T17 Propuesta: comprobación de tipos con JSDoc y tsc --checkJs --noEmit en estado, almacenamiento y bucle del agente
- [x] M79-T18 Almacenamiento: readConversation debe comparar updatedAt entre la copia del backend y la local en vez de dar siempre la razón al backend, para no perder mensajes editados en modo normal (2026-11-18)
- [x] M79-T19 Documentar en AGENTS.md los comandos de .zerochat/task.py (add-task, done, status) para que los agentes lo usen en lugar de editar a mano .zerochat/plan.md (2026-11-18)
- [x] M79-T20 Panel de razonamiento: facilitar crear un proyecto nuevo y cambiar de proyecto desde el propio panel (2026-11-18)
- [x] M79-T21 Diálogo de permisos: mostrar la línea completa del comando o de la acción en vez de truncarla (2026-11-18)
- [x] M79-T22 Historial: selector de proyecto siempre visible con el actual, no-project y Todos los proyectos, que muestra todos los grupos plegados (2026-11-18)
- [x] M79-T23 Crear un chat en no-project estando conectado desde su cabecera del historial y desde el cambio de proyecto de T20 (2026-11-18)
- [x] M79-T24 Renombrar la carpeta de los chats sin proyecto de no-project a general (~/zerochat/general) (2026-11-18)
- [x] M79-T25 Backend: zerochat/project/browse (solo subcarpetas no ocultas, con tope y aviso) y zerochat/project/create_directory (solo bajo ~), sin acceso para la credencial del runner (2026-11-18)
- [x] M79-T26 Diálogo para elegir la carpeta de trabajo: ruta pegada, recientes con general fija, navegación por carpetas y nueva carpeta (2026-11-18)
- [x] M79-T27 Propuesta de simplificación de los diálogos entre frontend y backend (reducir y unificar llamadas, mejorar estabilidad y simplificar código) (2026-11-18)
- [x] M79-T28 Unificar el transporte en / (retirar /mcp/external y el segundo McpClient) y entregar tools, externalTools y policies en initialize, set_directory y servers/* (2026-11-18)
- [x] M79-T29 Contexto del proyecto en una sola llamada silenciosa (zerochat/project/context, e incluido en initialize y set_directory) en lugar de 3 tools/call read_file (2026-11-18)
- [x] M79-T30 Unificar consultas de comandos: zerochat/jobs/log con tail y detalles del comando, y jobs en marcha en zerochat/jobs/stop (2026-11-18)
- [x] M79-T31 Navegador bajo demanda, caché de rutas de Playwright en BrowserEngines, config en engines/list|remove y sin rebote checking en Ajustes › MCP (2026-11-18)
- [x] M79-T32 Evitar llamadas redundantes en blobs (caché en memoria de blobId sincronizados) y en recargas de sesiones al conectar o terminar ejecuciones (2026-11-18)
- [x] M79-T33 Revisión de higiene y calidad del código de M79: retirar zerochat/browser/config/get y ramas muertas, fijar caché de blobs por PROXY_ID y sincronizar README (2026-11-18)
- [x] M79-T34 Al cambiar de carpeta desde el panel de razonamiento, abrir siempre un chat nuevo (también desde uno vacío) (2026-11-18)
- [x] M79-T35 Mostrar línea de estado en la base del historial al sincronizar o buscar conversaciones (2026-11-18)
- [x] M79-T36 Optimizar esperas de cierre de servidor HTTP en los tests del runner (2026-11-19)
- [x] M79-T37 Simplificación conceptual y agrupación de la suite de pruebas (2026-11-19)
- [x] M79-T38 Retirar el control de herramientas y el parámetro --allow-dangerous-tools en ejecuciones en servidor y --prompt (2026-11-19)
- [x] M79-T39 Borrar conversaciones solo del conjunto seleccionado en el filtro del historial e indicarlo en la confirmación (2026-11-19)
- [x] M79-T40 Conservar project en switchToSession del runner de Node para habilitar herramientas locales en ejecuciones en servidor (2026-11-19)
- [x] M79-T41 Guardar el directorio de trabajo (project) en las conversaciones creadas con zerochat --prompt para agrupar los agentes por proyecto en el historial (dropped: cubierta por la unificación de metadatos de sesión en M79-T44 y M79-T45)
- [x] M79-T42 Permitir restringir el acceso al directorio de trabajo en zerochat --prompt y ejecuciones desatendidas (en lugar de forzar allow_all), diferenciando agentes de mantenimiento y agentes contenidos (2026-11-19)
- [x] M79-T43 Decidir e implementar cómo un agente puede leer la salida de otro (herramienta de lectura/búsqueda de conversaciones vs. resumen en fichero .md) (2026-11-19)
- [x] M79-T44 Unificar proyecto activo en MCP (currentProject) y extraer en ConversationService una función pura compartida de metadatos de sesión (buildSessionMetadata con project, title, createdAt, profileId y serverRun), sin guardas de Node ni tocar IndexedDB (2026-11-19)
- [x] M79-T45 Adelgazar js/run-node.js moviendo la gestión de sesión headless a js/headless-adapters.js y consumiendo buildSessionMetadata de ConversationService (2026-11-19)
- [x] M79-T46 Avisos al usuario: valorar un servicio MCP para usar ntfy o un servicio MCP de IMAP (2026-11-19)
- [x] M79-T47 Actualizar proyecto en página vacía (reentrada en ChatState), desactivar interruptor del modo proyecto en general y mostrar proyecto en permisos de directorio (2026-11-19)
- [x] M79-T48 Sincronizar conversaciones externas (--prompt) mediante conversations_rev en live_state y añadir botón de sincronizar en el pie del historial (2026-11-19)
- [x] M79-T49 Unificar el latido periódico (10 s / 2 s y al volver a la pestaña) en todos los modos de servidor (2026-11-19)
- [x] M79-T50 Resolver rutas relativas con .. respecto a la carpeta del proyecto en SecurityContext.absolute antes de normalizar (2026-11-19)
- [x] M79-T51 Distinguir visualmente los campos de solo lectura ([readonly]) en modales, incluida la regla automática de directorio (2026-11-19)
- [x] M79-T52 Reglas de directorio RWX editables por proyecto (X habilita run_command y el proyecto empieza editable en RWX) (2026-11-19)
- [x] M79-T56 Cabecera de proyectos sin iconos de acción, abrir carpeta en app-header, nueva pestaña con proyecto actual y aviso al abrir chat de otro proyecto (2026-11-20)
- [x] M79-T57 Guardado de conversaciones en tramos bajo el tope HTTP de 1 MiB (zerochat/conversations/save_chunk) (2026-11-20)
- [x] M79-T58 Backend de permisos: retirar `workspace_trust` (unificándolo en `ask` + reglas `RWX:<cwd>/**` del proyecto) y aislar `commandPatterns` por proyecto en `export_state` y `update_state`: (2026-11-20)
  - `py/security/rules.py`: mantener `GLOBAL_POLICY_ASK = "ask"` y `GLOBAL_POLICY_ALLOW_ALL = "allow_all"`; retirar `workspace_trust` como política activa pero normalizar cualquier valor heredado `"workspace_trust"` a `"ask"` en la lectura de SQLite y validación de payloads (`_validate_state_payload`, `_normalize_permanent_state`) para retrocompatibilidad sin error 400.
  - `py/security/controller.py` (`_evaluate`): eliminar las dos ramas de `GLOBAL_POLICY_WORKSPACE_TRUST` (en `COMMAND_TOOL` y en `DIRECTORY_PATH_TOOLS`), de modo que la confianza en el proyecto resida exclusivamente en la lista `directoryRules` del proyecto (que por defecto es `[RWX:<cwd>/**]` cuando no hay reglas guardadas y se respeta tal cual si el usuario la edita o vacía a `[]`).
  - `py/security/controller.py` (`_effective_state` / `export_state`): no exponer nunca rutas ni patrones de otros proyectos; exportar `commandPatterns` con la forma `{ "global": [...], "project": [...], "session": [...] }`, donde `"project"` es únicamente la lista de `state["commandPatterns"]["projects"].get(context.key, [])`.
  - `py/security/controller.py` (`_apply_state_patch` / `update_state`): aceptar parches de `commandPatterns` con `{ "global": [...], "project": [...] }` (además de compatibilidad con `"projects"` si se pasa) actualizando solo `current["commandPatterns"]["global"]` y `current["commandPatterns"]["projects"][context.key]` (eliminando la clave `context.key` si la lista queda vacía) y preservando intactos los patrones de los demás proyectos en SQLite.
  - `py/cli/main.py`: en `reset_session_authorizations` para ejecuciones `--prompt` sin `tool_security` explícito, usar `GLOBAL_POLICY_ASK` en lugar de `GLOBAL_POLICY_WORKSPACE_TRUST` (ya que `RWX:<cwd>/**` por defecto cubre el directorio del proyecto).
  - Recompilar `zerochat.py` con `npm run build:backend`.
- [ ] M79-T59 Frontend de permisos (`js/tool-security.js`, `js/ui-settings.js`, `js/ui-mcp.js`, `js/i18n.js`):
  - `js/tool-security.js`: actualizar `EMPTY_STATE` y `getCommandPatterns()` al contrato `{ global: [], project: [], session: [] }`, sin mapa `projects` multi-proyecto en el cliente.
  - `js/ui-settings.js` (Tarjeta 1 — Política de Ejecución): retirar el tercer selector `workspace_trust` (`input[name="mcp-global-policy"][value="workspace_trust"]`), dejando únicamente 2 opciones claras: `ask` (aplicar las reglas `RWX` del proyecto y las autorizaciones guardadas, preguntando para el resto) y `allow_all` (permitir todas las ejecuciones sin preguntar).
  - `js/ui-settings.js` (botón `#btn-clear-mcp-auths` «Restablecer todas»): enviar `commandPatterns: { global: [], project: [] }` para limpiar solo los patrones globales y del proyecto actual sin borrar en SQLite los de otros proyectos.
  - `js/ui-mcp.js` (`renderSavedAuthorizations`, `renderCommandPatterns`, `updateSavedPatterns`, `removeCommandPattern`, `addCommandPattern`, `clearAllCommandPatterns`):
    - Renderizar únicamente hasta 3 grupos de alcance para `run_command`: proyecto actual (`patterns.project`), global (`patterns.global`) y sesión (`patterns.session`), sin listar jamás carpetas de otros proyectos.
    - En `updateSavedPatterns(change)`, leer y enviar `{ global, project }` en lugar de `{ global, projects }`; el selector de nuevo patrón con alcance `project` añade a `project` (sin depender de `currentProjectDir()` como clave de diccionario en el cliente) y la papelera de patrones envía `{ global: [], project: [] }`.
    - Mostrar insignia de alcance (`Global` vs `Sesión`) en las herramientas y servidores autorizados en la lista de autorizaciones guardadas.
  - `js/i18n.js`: actualizar los textos de `mcp_security_policy_ask` / `mcp_security_policy_ask_hint`, `mcp_security_policy_allow_all` / `mcp_security_policy_allow_all_hint` y `mcp_directory_rules_desc` en los 6 idiomas (`es`, `en`, `fr`, `de`, `pt`, `zh`) para reflejar que `ask` delega en las reglas `RWX` del proyecto y retirar las claves huérfanas de `workspace_trust`.
- [ ] M79-T60 Pruebas y documentación del modelo de permisos simplificado (`tests/`, `py/README.md`, `js/README.md`):
- [x] M79-T61 Corregir orden de cascada @media (max-width: 640px) en header.css para evitar solapamiento de carpeta y perfil en móvil (2026-11-20)
  - `tests/python/test_mcp_proxy.py`: actualizar los tests de `GLOBAL_POLICY_WORKSPACE_TRUST` para comprobar que `"workspace_trust"` se normaliza a `"ask"` y que la confianza por defecto en el proyecto la gobierna `[RWX:<cwd>/**]` (y su edición o vaciado a `[]` en `directoryRules`); actualizar los tests de `commandPatterns` al contrato `{ global, project, session }` en `export_state` y verificar que `update_state` desde un proyecto A no expone ni borra los patrones guardados de un proyecto B.
  - `tests/integration/test_tool_security.js`, `tests/browser/browser_mcp_panel.test.js` y `tests/unit/test_i18n.js`: adaptar los mocks y aserciones a `commandPatterns: { global, project, session }` y a los 2 selectores de `globalMcpPolicy` (`ask` y `allow_all`).
  - `py/README.md` y `js/README.md`: actualizar la documentación de `AccessController` y `ChatToolSecurity` describiendo los 2 modos (`ask` y `allow_all`), la delegación del acceso al proyecto en `directoryRules` (`RWX:<cwd>/**` por defecto) y el aislamiento por proyecto de `commandPatterns` en `export_state` y `update_state`.
  - Ejecutar la validación completa (`pytest` y `npm test`).




