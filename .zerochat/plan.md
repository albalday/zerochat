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

Goal: Que se pueda trabajar en varios proyectos a la vez desde cualquier pestaña o dispositivo sin mezclar carpeta, permisos de sesión, retos, comandos ni historia de chats entre proyectos; lo permanente (SQLite) sigue compartido. Sesión = proyecto: quien trabaja en el mismo proyecto (otra pestaña, la tablet) comparte su estado y puede continuar el trabajo desde otro sitio; abrir una conversación lleva a su proyecto. Multiusuario fuera del proceso: un contenedor por usuario, solo documentado.
Done when: Cada conversación guarda su proyecto y la barra lateral muestra las del proyecto actual (filtro "todos", grupo "Sin proyecto"); cada petición indica su proyecto en una cabecera y el servidor usa el estado de ese proyecto (carpeta, permisos y patrones de sesión, retos, comandos, live_state), creándolo si no existe; no queda os.chdir, Path.cwd() ni os.getcwd() fuera del arranque (prueba de arquitectura); las ejecuciones en servidor arrancan en el proyecto de su conversación; un navegador en uso por otra conversación devuelve error y se libera por inactividad; hay un tope de proyectos con estado en memoria (probado en N y N+1); el límite multiusuario y el uso de worktrees en paralelo están documentados; y todos los niveles de §4 pasan en verde.
Decisiones: sin identidad de cliente (ni clientId ni Mcp-Session-Id): PC y tablet comparten el estado del proyecto (M62-D3); sin caducidad por tiempo, el estado dura lo que el servidor; al pasar del tope se libera el proyecto usado hace más tiempo sin comandos en marcha y, si todos los tienen, el nuevo recibe error; un estado liberado se recrea vacío sin avisar; el heartbeat sigue siendo global; no se sincronizan ficheros, memory ni una misma conversación en dos pestañas (aislar con worktrees). Orden de ejecución: T1, T2, T5, T10, T4, T6, T7, T8, T9.
- [x] M62-T1 Proyecto en cada conversación (extra_json.project, cabecera project) e historia por proyecto: filtro en conversations/list y en la caché de IndexedDB, vista "todos los proyectos" agrupada por carpeta y grupo "Sin proyecto" (2026-11-12)
- [x] M62-T2 Abrir una conversación de otro proyecto lleva la pestaña a ese proyecto; start_server_run y el modo proyecto usan el proyecto de la conversación; si la carpeta ya no existe, la conversación se abre con aviso y sin herramientas, nunca en otra carpeta (2026-11-12)
- [x] M62-T3 Registro de sesiones: clientId en localStorage enviado en initialize, Mcp-Session-Id en la respuesta y en cada petición; set_directory devuelve la sesión del nuevo proyecto; sesión desconocida -> la interfaz vuelve a iniciar sin que se note (dropped: sesión = proyecto, sin identidad de cliente, M62-D3; lo sustituye M62-T10)
- [x] M62-T4 Permisos de sesión, patrones de sesión y retos pendientes pasan de AccessController al estado del proyecto; un reto solo se resuelve en su proyecto; cambiar de proyecto ya no borra nada (2026-11-12)
- [x] M62-T5 Contexto explícito en todas las herramientas, comandos y diff (rutas por context.resolve), todavía con un solo proyecto y sin cambio de comportamiento; quitar os.chdir; prueba de arquitectura contra os.chdir, Path.cwd() y os.getcwd() fuera del arranque (2026-11-12)
- [x] M62-T6 Comandos y live_state por proyecto: check_command y la lista de comandos solo ven los del proyecto de la petición; el heartbeat sigue siendo global (2026-11-12)
- [x] M62-T7 Navegadores (browser_action y Playwright MCP) en uso por una conversación: conversationId en _meta de tools/call, error claro para las demás y liberación por inactividad (2026-11-12)
- [x] M62-T8 Tope de proyectos con estado en memoria: se libera el usado hace más tiempo sin comandos en marcha y, si todos los tienen, error (N y N+1) (2026-11-12)
- [x] M62-T9 Documentar en py/README y en la ayuda es/en: estado por proyecto compartido entre pestañas y dispositivos, worktrees para trabajar en paralelo y un contenedor por usuario para multiusuario (2026-11-12)
- [x] M62-T10 Proyecto de cada petición en una cabecera: el servidor valida la carpeta y busca o crea el estado de ese proyecto; set_directory solo cambia el proyecto de la pestaña (2026-11-12)
- [x] M62-T11 Barra lateral: la vista del proyecto muestra también las conversaciones sin proyecto; separar el selector de la agrupación (2026-11-12)
- [x] M62-T12 start_server_run de una conversación sin proyecto arranca en el proyecto de la petición (2026-11-12)
- [ ] M62-T13 Reserva del navegador al ejecutar (directo y tras el reto), no al pedir; un solo cálculo del recurso
- [ ] M62-T14 Quitar el error inalcanzable del tope de sesiones y previous_cwd; una sola clave de proyecto (SecurityContext.key)
- [ ] M62-T15 ctx solo para los manejadores de herramientas que lo declaran
- [ ] M62-T16 Un solo resolutor de rutas en SecurityContext para permisos y ejecución
- [ ] M62-T17 Abrir una conversación espera al cambio de proyecto antes de darla por abierta
- [ ] M62-T18 Avisar cuando la carpeta del proyecto de la pestaña deja de existir
