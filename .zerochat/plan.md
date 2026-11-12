# Plan

<!-- Hitos M1 a M51 archivados en .zerochat/archive/ -->

## M52 Robustez del transporte web en servidor: cabeceras de navegación y cadencia frente a retos anti-bot: closed 2026-11-08

## M53 Simplificación de la suite de pruebas, retirada de tests obsoletos y optimización de WebLLM: closed 2026-11-09

## M54 Mejoras al modo proyecto: normalización modal del panel de razonamiento y simplificación de memoria: closed 2026-11-09

## M55 Mejoras simples: closed 2026-11-10

## M56 Migración del control de acceso a MCPs y ejecuciones al backend y desacoplo para evolución multiusuario: closed 2026-11-10

## M57 Bucle agéntico desatendido en Node.js para --prompt y --conversation: closed 2026-11-10

## M58 Soporte de ejecución de JavaScript (execute_javascript) en Node.js desatendido: closed 2026-11-11

## M59 Habilitar render_chart en Node.js desatendido para visualización en cliente: closed 2026-11-11

## M60 Frontend sin evaluación de permisos: closed 2026-11-11

## M61 Integridad del sistema de permisos: closed 2026-11-12

## M62 Multisesión de un usuario y límites del multiusuario

Goal: Que cada navegador o dispositivo trabaje en su propio proyecto con su propia sesión, sin mezclar permisos de sesión, retos, comandos ni historia de chats con los de otro proyecto o dispositivo; lo permanente (SQLite) sigue compartido. Sesión = (clientId del navegador, proyecto): las pestañas de un mismo navegador en el mismo proyecto la comparten, cambiar de proyecto cambia de sesión y abrir una conversación lleva a la sesión de su proyecto. Multiusuario fuera del proceso: un contenedor por usuario, solo documentado.
Done when: Cada conversación guarda su proyecto y la barra lateral muestra las del proyecto actual (filtro "todos", grupo "Sin proyecto"); la interfaz se identifica en initialize con un clientId de localStorage y recibe Mcp-Session-Id, que repite en cada petición; los permisos de sesión, los retos, la carpeta del proyecto, los comandos, live_state y el heartbeat son de la sesión; no queda os.chdir, Path.cwd() ni os.getcwd() fuera del arranque (prueba de arquitectura); las ejecuciones en servidor arrancan en el proyecto de su conversación; un navegador en uso por otra conversación devuelve error; las sesiones duran lo que el servidor con un tope de 16 (probado en N y N+1); el límite multiusuario y el uso de worktrees en paralelo están documentados; y todos los niveles de §4 pasan en verde.
Decisiones: sin caducidad por tiempo (la sesión dura lo que el servidor, como la capa de sesión actual); al pasar del tope se libera la sesión usada hace más tiempo sin comandos en marcha y, si todas los tienen, la nueva recibe error; volver a un proyecto recupera su sesión si sigue viva; no se sincronizan ficheros, memory ni una misma conversación en dos pestañas (como Claude Code y Codex: aislar con worktrees); la IP no identifica (la tablet llega por el proxy Caddy).
- [ ] M62-T1 Proyecto en cada conversación (extra_json.project, cabecera project) e historia por proyecto: filtro en conversations/list y en la caché de IndexedDB, vista "todos los proyectos" agrupada por carpeta y grupo "Sin proyecto"
- [ ] M62-T2 Abrir una conversación de otro proyecto lleva la pestaña a ese proyecto; start_server_run y el modo proyecto usan el proyecto de la conversación
- [ ] M62-T3 Registro de sesiones: clientId en localStorage enviado en initialize, Mcp-Session-Id en la respuesta y en cada petición; set_directory devuelve la sesión del nuevo proyecto; sesión desconocida -> la interfaz vuelve a iniciar sin que se note
- [ ] M62-T4 Permisos de sesión, patrones de sesión y retos pendientes pasan de AccessController a la sesión; un reto solo lo resuelve su sesión; RUN_SESSION es una sesión más
- [ ] M62-T5 Carpeta del proyecto por sesión: quitar os.chdir, rutas por session.resolve en herramientas, comandos y diff; prueba de arquitectura contra os.chdir, Path.cwd() y os.getcwd() fuera del arranque
- [ ] M62-T6 Comandos, live_state y heartbeat por sesión: check_command solo ve los suyos; el servidor se cierra cuando no queda ninguna pestaña conectada
- [ ] M62-T7 Navegadores (browser_action y Playwright MCP) en uso por una conversación: conversationId en _meta de tools/call y error claro para las demás hasta que termine su turno
- [ ] M62-T8 Tope de 16 sesiones con liberación de la usada hace más tiempo sin comandos en marcha y error si todas los tienen (N y N+1)
- [ ] M62-T9 Documentar en py/README y en la ayuda es/en: sesiones por navegador y proyecto, worktrees para trabajar en paralelo y un contenedor por usuario para multiusuario
