# Plan

<!-- Hitos M1 a M77 archivados en .zerochat/archive/ -->

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora: closed 2026-11-20

## M80 Entorno de ejecución por proyecto: closed 2026-11-20

## M81 Propuestas de mejora
- [x] M81-T1 Propuesta: regenerar respuestas y editar la pregunta in situ, creando una rama automáticamente — descartada (2026-11-20): el botón "reutilizar prompt en el composer" ya cubre el caso y la bifurcar existente permite crear la rama manualmente
- [x] M81-T2 Propuesta: atajos de teclado (nueva conversación, buscar con Ctrl+K, parar con Esc, ayuda con ?) (dropped: bajo valor frente a la superficie que añade (? choca con el foco en el compositor, Ctrl+N lo reserva el navegador y Esc arriesga cortes accidentales en tareas largas))
- [x] M81-T3 Propuesta: notificación en el título/icono de la pestaña cuando un turno termina en segundo plano o pide permiso, sin usar la API Notification (2026-11-20)
- [ ] M81-T4 Propuesta: prompts guardados, globales o por proyecto, insertables en el compositor con /
- [ ] M81-T5 Propuesta: asistente de primer perfil que detecta servidores locales bajo demanda y una tabla de qué funciona en navegador y servidor
- [ ] M81-T6 Propuesta: respaldo y restauración del almacén del servidor (zerochat --backup y --restore)
- [ ] M81-T7 Propuesta: RAG híbrido opcional, combinando /v1/embeddings del servidor de modelos con Orama
- [ ] M81-T8 Propuesta: batería de evaluación de agentes con zerochat --prompt contra modelos locales, sin tuning por modelo
- [ ] M81-T9 Propuesta: control de concurrencia entre pestañas con versión por conversación y 409 al guardar sobre versión obsoleta
- [ ] M81-T10 Propuesta: chequeo de tipos con JSDoc y tsc --checkJs --noEmit en el estado, el almacenamiento y el bucle de agentes
- [ ] M81-T11 Diálogo de permisos: limitar la línea de comandos a aprobar a un máximo de 2 líneas
- [ ] M81-T12 Propuesta: cortar el contenedor de ejecución de tools tras 20 tarjetas y abrir uno nuevo
- [x] M81-T13 Simplificación: unificar la persistencia del backend en SQLite (mover config/browser.json con extensionToken en secrets, config/services.json y runs/*.json a SQLite) (2026-11-20)
- [x] M81-T14 Simplificación: unificar el modelo de proyecto (mover activeRagBranchIds al entorno por proyecto, adelgazar runtime_config_v2 a preferencias globales y separar por proyecto security_policies) (2026-11-20)
- [x] M81-T15 A discutir con el usuario: simplificación de búsqueda de conversaciones delegando searchConversations a SQLite (zerochat/conversations/search) cuando hay backend conectado en lugar de descargar pendientes a IndexedDB (dropped: la búsqueda en frontend es obligatoria para el modo sin conexión; duplicarla en SQLite añade más complejidad que replicar el texto pendiente (sin blobs) en IndexedDB)
- [x] M81-T16 Simplificación de la réplica de perfiles: retirar deletedIds, remoteByName y la opción destructiva de reemplazo al cambiar de serverId (el diálogo de control solo ofrece fusionar o cancelar sin borrar perfiles locales) (2026-11-20)
- [x] M81-T17 Quitar polling: en check_command (py/tools/job_waits.py), eliminar WAIT_SLICE_SECONDS haciendo que WAITS.cancel notifique job._changed para esperar en un solo wait(remaining) (2026-11-20)
- [x] M81-T18 Quitar polling: en _kill_process_tree (py/core/process.py), sustituir time.sleep(grace_seconds) por proc.wait(timeout=grace_seconds) cuando el objetivo es un Popen (2026-11-20)
- [x] M81-T19 Quitar polling: en run_supervisor (py/run_mode/supervisor.py), sustituir el bucle RUN_POLL_SECONDS/proc.poll() por espera síncrona sobre un evento compartido con proc.wait() y el apagado (2026-11-20)
- [x] M81-T20 Quitar polling: en arranque de servicios MCP (js/mcp-external.js, py/mcp/), sustituir el timeout corto + polling de 15 s por espera síncrona / long-poll al cambiar de fase, aparecer oauthUrl o terminar (2026-11-20)
- [x] M81-T21 Quitar polling: en log en vivo de comandos (js/command-card.js, py/tools/jobs_rpc.py), sustituir pollLog() cada 2 s por long-poll (wait_ms) reutilizando job.wait_change (2026-11-20)
- [x] M81-T22 Quitar polling: en instalación de motores Playwright (js/ui-browser.js, py/browser/engines.py), sustituir el sondeo cada 1 s de engines/list por espera síncrona o long-poll con Condition sin re-escanear navegadores del sistema (2026-11-20)
- [x] M81-T23 Quitar polling: en zerochat/heartbeat y heartbeat_watchdog (js/mcp.js, py/server/state.py), pasar a long-poll por versión de estado (since_rev, wait_ms) manteniendo solo-POST, quitar el polling rápido de 2 s de focus_run y esperar remaining exacto en watchdog (2026-11-20)
- [x] M81-T24 A discutir con el usuario: cambiar el comportamiento de los borrados de mensajes — hoy la papelera aparece en todos los mensajes y borra por turno (pregunta+respuesta juntas); valorar mostrarla solo en el último turno. La sincronización con el backend no es un problema (reemplazo completo de la conversación en IndexedDB y SQLite, con limpieza de blobs huérfanos en ambos lados) (2026-11-20)
- [x] M81-T25 Auditoría de calidad de M81: latido sin output_bytes/last_line en rev, código muerto, avisos y long-poll unificados (2026-11-21)
- [x] M81-T26 Pruebas de seguridad: no ejecutar sudo real al aprobar retos de run_command (2026-11-21)
- [x] M81-T27 Seguridad: órdenes globales de run_command por ejecutable real (comillas, escapes, rutas) y pkexec/run0 (2026-11-21)
- [ ] M81-T28 Seguridad en Windows: partir y validar los comandos de run_command según la shell real (cmd/PowerShell) en vez de shlex POSIX, que se come las \ de las rutas (C:\x queda C:x) en split_command, cd_target, command_outside_references y patrones

## M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20

Goal: que cada agente que trabaja en este repositorio traiga a .zerochat/ lo que solo guarda en su memoria privada.
Done when: el usuario confirma que todos los agentes que usa lo han hecho.
- [ ] M82-T1 Cada agente que lea esta tarea revisa su memoria privada de este proyecto frente al código y a .zerochat/, propone al usuario las tareas, decisiones y normas aún vigentes y no registradas (nunca secretos ni datos personales), las escribe una vez aprobadas y pregunta al usuario antes de marcar la tarea como hecha, porque otros agentes pueden faltar todavía
