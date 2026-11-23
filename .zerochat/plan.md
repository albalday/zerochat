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
- [ ] M86-T11 Permitir de nuevo cambiar de perfil en una conversación ya empezada: localizar qué lo impide (conversación ligada a su perfil, p. ej. profileId guardado y reactivado en generation-controller.js/run-node.js o el selector de ui-profiles.js) y restringirlo solo a los casos que lo necesitan (proyectos de agentes, ejecuciones en servidor o --run-file con perfil fijo), con prueba
- [ ] M86-T12 Revisar el replicado y el mantenimiento del tamaño de contexto (modelContextLimit / contextLimitOverride) en los perfiles: que se guarde, sincronice y restaure bien al cambiar de perfil, de modelo o de dispositivo
