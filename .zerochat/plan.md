# Plan

<!-- Hitos M1 a M77 archivados en .zerochat/archive/ -->

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora: closed 2026-11-20

## M80 Entorno de ejecución por proyecto: closed 2026-11-20

## M81 Propuestas de mejora: closed 2026-11-21

## M83 Esperas síncronas en lugar de sondeo (restos tras M81): closed 2026-11-21

## M84 ZeroChat como ejecutor para orquestadores de agentes: closed 2026-11-21

## M85 Secretos por proyecto y relleno seguro en navegador: closed 2026-11-22

## M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20: closed 2026-11-22

## M86 Mejoras para proyectos de agentes y `--run-file`

Goal: pulir la ejecución desatendida con `--run-file` y las plantillas de proyectos de agentes a partir de la experiencia práctica con agentes reales.
Done when: las mejoras acordadas en M86 están implementadas con todos los niveles de §4 en verde.
- [ ] M86-T1 Controlar en `--run-file` la inyección de normas en sistema del proyecto (`projectMode` booleano opcional en `RUN_FILE_KEYS` / runner, o desactivado por defecto cuando el agente define su propio manual operativo): decidir y aplicar si `--run-file` inyecta o excluye `AGENTS.md` y `.zerochat/state.md`, actualizando `templates/project/mode-agent.txt` y `mode-agent-templates.txt`
- [x] M86-T2 Persistir el último User-Agent real del navegador en SQLite y añadir en Ajustes › Navegador y py/browser/config.py modo automático/rotativo por sesión o personalizado (actualizando DEFAULT_USER_AGENT) (2026-11-22)
- [x] M86-T3 Permitir canal chrome/navegador del sistema en modo propio headless (--browser=chrome --headless --isolated) en py/browser/config.py y Ajustes › Navegador para ejecuciones desatendidas sin sesión gráfica (2026-11-22)
- [x] M86-T4 Bloquear zerochat/project/delete con ejecuciones en marcha del proyecto (las filas de runs no tienen 'project': cruzar conversation_id con el proyecto de la conversación) con prueba, hacer atómico delete_project_storage (conversaciones y resto en una transacción) y borrar el directorio solo tras borrar los datos (2026-11-23)
- [x] M86-T5 Refactor de py/storage/db.py: una sola fuente para el prefijo 'project:' (políticas, secretos, LIKE y has_nested_project_data), helper único para validar project_key (11 copias) y gestor de contexto para BEGIN IMMEDIATE/COMMIT/ROLLBACK; retirar el settings.pop('mcpServers'/'playwrightBrowser') de save_profile que ya cubre la migración 009 (2026-11-23)
- [x] M86-T6 User-Agent con una sola fuente: DEFAULT_USER_AGENT de web/fetch.py y MODERN_USER_AGENTS[0] de browser/config.py, load_last_frontend_user_agent reutilizando _validate_user_agent, y effective_user_agent sin leer SQLite en cada petición web (2026-11-23)
- [x] M86-T7 Frontend: usar Utils.NO_PROJECT_NAME (o una constante única de clave de proyecto) en lugar del literal 'general' en js/config-store.js y js/storage.js, y unificar normalizeMcpServers con normalizeUniqueIdList (2026-11-23)
- [x] M86-T8 Secretos de proyecto: retirar la rama value=null de zerochat/project/secrets/set (ya existe secrets/delete), y en Ajustes que refreshProjectSecrets muestre el error real en vez de 'sin conexión' y no se llame dos veces al abrir Permisos (sacarlo de syncProjectScopeLabels) (2026-11-23)
- [x] M86-T9 Subida de conversaciones por tramos: liberar la subida pendiente cuando falla un tramo (RPC de cancelación o reintento) y comprobar en el frontend totalChunks <= MAX_CONVERSATION_UPLOAD_CHUNKS antes de empezar, con prueba en el borde (2026-11-23)
- [x] M86-T10 Legibilidad: agrupar en un dataclass los parámetros de _apply_state_patch y _forget_session_overrides (security/controller.py), exponer públicamente la validación de systemDataPrompt que importa run_mode/state.py y encapsular el acceso a session._wake (2026-11-23)
- [x] M86-T11 Permitir cambiar libremente de perfil en cualquier conversación normal ya empezada: retirar en `applySessionModeAndProfile` (`js/app.js`) la reactivación automática de `conversation.profileId` al abrir o sincronizar una conversación (`syncServerRunControl`), de modo que el selector de perfiles (`js/ui-profiles.js`) gobierne siempre el perfil activo de la pestaña sin que la conversación lo fuerce, con prueba (2026-11-23)
- [ ] M86-T12 Revisar el replicado y el mantenimiento del tamaño de contexto (modelContextLimit / contextLimitOverride) en los perfiles: que se guarde, sincronice y restaure bien al cambiar de perfil, de modelo o de dispositivo
- [ ] M86-T13 Añadir campo opcional agent (<subconjunto>.<nombre>, dos niveles; cada segmento [a-z0-9_-]+ con longitud máxima acotada y validada en una sola fuente) en --run-file y persistirlo en los metadatos de la conversación (extra_json en SQLite, inmutable como project); continuar con --run-file una conversación existente con otro agent o sin él es error de argumentos, no se ignora ni se remarca; el campo llega al frontend en la cabecera de sesión (db.py, junto a project) y al runner; actualizando templates/project/mode-agent*.txt y con pruebas
- [ ] M86-T14 Modo supervisión (solo lectura / HITL) para conversaciones de agentes (Boolean(session.agent)): al abrirlas en la UI no cambiar el proyecto activo (omitir confirmProjectSwitch en conversation-service.js y followConversationProject en app.js) ni el perfil/modo servidor activo de la pestaña; deshabilitar el envío libre en el compositor y las acciones de editar/borrar último turno (onReuse/onDelete), permitiendo únicamente: (1) responder a un needs_input pendiente (aprobar/denegar reto de herramienta o contestar a ask_user pendiente reanudando la ejecución en servidor con el proyecto y profileId propios de la conversación), y (2) crear una rama (onBranch) que nazca como conversación normal de usuario (sin agent), con pruebas. Pendiente de aclarar con el usuario antes de empezar: (a) tras M86-T11 la reanudación de needs_input debe pasar explícitamente el profileId de la conversación a ServerRun.start (js/server-run.js); (b) confirmar que también se permiten cancelar la ejecución en marcha y exportar/copiar; (c) si se parte en dos tareas (solo lectura sin cambiar proyecto ni perfil / respuesta a needs_input y rama)
- [ ] M86-T15 Separar y agrupar las conversaciones de agentes en el historial de la barra lateral (js/ui-sidebar.js): evitar que las ejecuciones con session.agent se mezclen con los chats humanos por fecha, añadiendo vista/filtro o secciones plegables por namespace (<subconjunto> y <nombre> del agente) tanto en el proyecto actual como en Todos/Pendientes, mostrando su identificador de agente y estado de ejecución, con pruebas
- [ ] M86-T16 Supervisión de agentes controlados para un agente master y retirada de --list-conversations: añadir campo opcional watchAgents en --run-file (lista de patrones de namespace del mismo proyecto: '*', '<subconjunto>.*' o '<subconjunto>.<nombre>') que habilita y autoriza en sesión únicamente para esa ejecución la herramienta local check_agents; check_agents cruza conversations y runs filtrando estrictamente por project == ctx.workspace_dir y agent cubierto por watchAgents (nunca chats humanos ni otros proyectos), devolviendo en modo listado el estado de cada agente controlado (agent, conversation_id, status, updated_at, finished_at, step_text, pending, error, warnings, resumen de result_text) y con agent/conversation_id el detalle y mensajes del último turno acotados en tamaño; retirar --list-conversations de py/cli/main.py, actualizar templates/project/mode-agent*.txt y py/README.md, y registrar Supersedes parcial de M79-D8 al cerrar, con pruebas
