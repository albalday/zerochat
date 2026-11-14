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

## M62 Multisesión de un usuario y límites del multiusuario: closed 2026-11-12

## M63 Cambios pequeños y pruebas: closed 2026-11-13

## M64 Modularización del backend Python: closed 2026-11-13

## M65 Aislamiento de las ejecuciones en servidor: closed 2026-11-13

## M66 Coordinadores del frontend: closed 2026-11-13

## M67 Arreglos de estabilización: closed 2026-11-13

## M68 Arreglos pequeños 2

Goal: Agilizar el cambio de proyecto desde el historial y aprovechar todo el ancho del móvil en el panel lateral de chats.
Done when: Cada cabecera de proyecto del historial muestra a su derecha un icono de nuevo chat que cambia el servidor a ese proyecto y abre un chat vacío sin cambiar el perfil activo; en móvil el panel lateral del historial ocupa todo el ancho de la pantalla; los diez hallazgos de la auditoría de la 10.15.0 (help/audit-infrastructure.html, F-01 a F-10) están corregidos o aceptados de forma expresa, cada uno con su prueba; español e inglés sincronizados y pasan las pruebas aplicables (§4).
- [x] M68-T1 Icono de nuevo chat a la derecha de cada cabecera de proyecto en el historial (`js/ui-sidebar.js` `renderGroupHeader`, `css/components/sidebar.css`): al pulsarlo (sin plegar/desplegar el grupo) cambia el servidor a esa carpeta (`MCP.manager.setProjectDirectory`, con el mismo aviso que `followConversationProject` en `js/app.js` si ya no existe) y abre un chat nuevo vacío conservando el perfil activo; título accesible en `js/i18n.js` (es/en) (2026-11-14)
- [x] M68-T2 Panel lateral del historial a pantalla completa en móvil (`css/components/sidebar.css`, media query móvil: hoy `width: 82vw; max-width: 320px`) usando todo el ancho de la pantalla (2026-11-14)
- [x] M68-T3 Rehacer la auditoría completa sobre la 10.15.0 (docs/audits/AuditFull.md): revisar los cambios desde la auditoría de la 10.14.0 (final de M63, M64 a M67) y reescribir las cinco revisiones de help/ en español e inglés con el estado actual, sin los hallazgos ya corregidos (2026-11-13)
- [x] M68-T4 Credencial de ejecución para el runner de Node: el backend entrega al runner un token propio que solo admite `tools/call`, `zerochat/run/*` y lo que su conversación necesita, y lo rechaza en `zerochat/security/*` y `zerochat/profiles/*`; prueba: con esa credencial, cambiar políticas, autorizar un reto o leer perfiles devuelve error (auditoría F-01) (2026-11-14)
- [x] M68-T5 `execute_javascript` en Node en un proceso aparte, sin el token ni el entorno del runner y terminado por señal al vencer el plazo; decidir antes con el usuario el mecanismo (revisa M65-D1 y M65-D2); pruebas: el escape por objetos heredados no alcanza el token ni el backend y un bucle asíncrono sin fin devuelve el error de plazo en el tiempo previsto (auditoría F-01, F-03) (2026-11-14)
- [x] M68-T6 Entorno mínimo para el proceso en `launch_node_runner` (`minimal_child_env` en `py/core/environment.py`, compartido con el sandbox de T5), sin huella de `runner.js` (M68-D6); prueba: una variable del entorno del servidor no llega al runner (auditoría F-02) (2026-11-14)
- [x] M68-T7 Acotar `js/html-document.js`: tope de profundidad con recorridos iterativos y una expresión de etiqueta que no retroceda; pruebas en el borde exacto de etiquetas con comilla sin cerrar y de anidamiento, con tiempo acotado y aviso de truncado (auditoría F-04) (2026-11-14)
- [x] M68-T8 Recoger los blobs sin referencia al guardar una conversación, en `py/storage/db.py` y `js/storage.js`, sin recorrer todos los mensajes en cada borrado; prueba: quitar el único mensaje que usa un blob lo elimina al guardar y se conserva el compartido (auditoría F-05) (2026-11-14)
- [x] M68-T9 Leer con una función de su módulo el estado que cambia en ejecución (`ACTIVE_HOST`, `ACTIVE_PORT`, `CONSOLE_CONTROL`, `RUN_SESSION`, `EXIT_ON_CLOSE`, `HEARTBEAT_INITIALIZED`) y que `scripts/build-backend.py` rechace importar un nombre que su módulo reasigna con `global`; prueba en `test_build_backend.py` (auditoría F-06) (2026-11-14)
- [x] M68-T10 Pruebas de borde `N` y `N+1` para `MAX_FINISHED_JOBS`, `WEB_FETCH_MAX_REDIRECTS`, `MAX_MCP_MESSAGE_CHARS` y los 128 caracteres de método y de nombre de herramienta (auditoría F-07) (2026-11-14)
- [ ] M68-T11 Retirar el inventario de símbolos `tests/fixtures/zerochat_symbols.json` y la opción `--symbols` de `scripts/build-backend.py`, o reducirlo a los nombres que las pruebas sustituyen (auditoría F-08)
- [ ] M68-T12 Seguir separando responsabilidades de `js/app.js` y `js/mcp.js` hasta dejarlos por debajo de mil líneas, sin cambiar el comportamiento; decidir antes qué sale de cada uno (auditoría F-09)
- [ ] M68-T13 Corregir en `help/tools-agent.html` y su traducción la frase del «sello temporal de un solo uso»: describir los permisos y los retos del servidor (auditoría F-10)
