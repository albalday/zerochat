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
Done when: Cada cabecera de proyecto del historial muestra a su derecha un icono de nuevo chat que cambia el servidor a ese proyecto y abre un chat vacío sin cambiar el perfil activo; en móvil el panel lateral del historial ocupa todo el ancho de la pantalla; español e inglés sincronizados y pasan las pruebas aplicables (§4).
- [ ] M68-T1 Icono de nuevo chat a la derecha de cada cabecera de proyecto en el historial (`js/ui-sidebar.js` `renderGroupHeader`, `css/components/sidebar.css`): al pulsarlo (sin plegar/desplegar el grupo) cambia el servidor a esa carpeta (`MCP.manager.setProjectDirectory`, con el mismo aviso que `followConversationProject` en `js/app.js` si ya no existe) y abre un chat nuevo vacío conservando el perfil activo; título accesible en `js/i18n.js` (es/en)
- [ ] M68-T2 Panel lateral del historial a pantalla completa en móvil (`css/components/sidebar.css`, media query móvil: hoy `width: 82vw; max-width: 320px`) usando todo el ancho de la pantalla
- [x] M68-T3 Rehacer la auditoría completa sobre la 10.15.0 (docs/audits/AuditFull.md): revisar los cambios desde la auditoría de la 10.14.0 (final de M63, M64 a M67) y reescribir las cinco revisiones de help/ en español e inglés con el estado actual, sin los hallazgos ya corregidos (2026-11-13)
