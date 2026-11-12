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

Goal: Que cada sesión de un mismo usuario (pestaña, conversación o dispositivo) tenga su propio proyecto, sus permisos de sesión y sus retos, sin que una autorización de sesión o un cambio de proyecto en una afecte a las demás; lo permanente (SQLite) sigue compartido. Multiusuario no se aborda dentro de un proceso: se documenta como un contenedor (tipo Docker) por usuario, porque shell, cwd y permisos del sistema no se aíslan dentro de un proceso.
Done when: La identidad de sesión está definida y viaja en cada petición; SecurityContext es el objeto sesión (carpeta del proyecto, permisos y patrones de sesión, retos pendientes) y AccessController solo guarda lo permanente; no queda os.chdir global; las sesiones caducan y tienen tope (probado en N y N+1); un reto solo lo resuelve su sesión; el overlay de RUN_SESSION es una sesión más; el límite multiusuario está documentado; y todos los niveles de §4 pasan en verde.
- [ ] M62-T1 Definir la identidad de sesión: pestaña, conversación o dispositivo; quién crea el id, cómo viaja en cada petición (el token diario es compartido por todas las pestañas y la tablet) y qué pasa al recargar
- [ ] M62-T2 Vida de las sesiones: apertura, caducidad, limpieza y tope de sesiones vivas en memoria
- [ ] M62-T3 Proyecto por sesión: sustituir el os.chdir global de dd-tools por la carpeta de la sesión (regla de directorio por defecto, patrones por proyecto, Workspace Trust y cwd de run_command)
- [ ] M62-T4 SecurityContext como objeto sesión: mover session_tools, session_servers, session_command_patterns, session_global_policy, session_directory_rules y pending_challenges desde AccessController; cambiar de proyecto solo limpia su sesión
- [ ] M62-T5 Retos ligados a la sesión que los creó, además de su cwd
- [ ] M62-T6 Overlay de ejecución en servidor (RUN_SESSION, allow_dangerous_tools, security_rules) como una sesión más, sin capa global
- [ ] M62-T7 Caché de permisos del frontend desactualizada cuando otra pestaña cambia lo permanente: refresco al recuperar el foco o aviso del backend (solo afecta a lo mostrado; decide el backend)
- [ ] M62-T8 Documentar el límite multiusuario (un contenedor por usuario) en py/README y en la ayuda es/en
