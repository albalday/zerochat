# Plan

<!-- Hitos M1 a M69 archivados en .zerochat/archive/ -->

## M70 Arreglos de run_command: closed 2026-11-14

## M71 Navegador de ficheros del proyecto: closed 2026-11-14

## M72 Catálogo de servicios MCP con versión independiente: closed 2026-11-16

## M73 Arreglos de seguridad: closed 2026-11-15

## M74 Arreglos multiplataforma de la 10.19.0: closed 2026-11-16

## M75 Arreglos menores: closed 2026-11-16

## M76 Ajustes de perfiles

Goal: Que los servicios MCP de un perfil se asignen desde un único sitio y que la nomenclatura restante y Brave en chat y en segundo plano queden coherentes y verificados.
Done when: los servicios MCP de un perfil se asignan en un solo sitio; perfiles, modos y textos usan los mismos nombres en código, interfaz (es y en) y ayuda; Brave, con un servidor recién arrancado, aplica replaces, enabledByDefault y rateLimit en el chat y en ejecución en segundo plano.
- [ ] M76-T1 Analizar y proponer un modelo único de asignación de servicios MCP (capítulo Servidores MCP del perfil vs Ajustes › MCP con Iniciar y recordar) y qué servicios arranca una ejecución en segundo plano
- [ ] M76-T2 Asignar los servicios MCP de un perfil en un único sitio
- [x] M76-T3 Editar y mantener los perfiles del servidor sin salir del modo «Ejecutar en servidor» (dropped: absorbido por el modelo unificado de almacenamiento y selector de M77)
- [ ] M76-T4 Normalizar la nomenclatura de perfiles y modos (ejecución en segundo plano, perfil de sesión, prefijo Z- y restos de nomenclatura previa) en código, interfaz es y en, y ayuda
- [ ] M76-T5 Comprobar con un servidor recién arrancado que Brave aplica replaces, enabledByDefault y rateLimit en el chat y en ejecución en segundo plano, y corregir lo que falle

## M77 Almacenamiento unificado y selector de perfiles

Goal: Unificar en un solo conjunto los perfiles (persistidos en navegador y backend), sincronizados al conectar conservando `updatedAt`, con detección de cambio de `serverId` y confirmación antes de fusionar, junto con un selector único con switch superior de segundo plano y un único botón de Guardar.
Done when: cada backend persiste su `serverId` en `zerochat.db` y lo expone en `live_state`, y `save_general_profile` conserva el `updatedAt` recibido; `profiles_v1` mantiene una sola lista con `serverId`, `deletedIds` y marca `synced` por perfil, consolidando al conectar por `updatedAt` y pidiendo `reveal` bajo demanda cuando el navegador usa o edita un perfil con clave en el servidor; al conectar a otro `serverId` con perfiles locales se pregunta si usar los del servidor o fusionarlos; el selector muestra una sola lista con switch superior de ejecución en segundo plano y el editor guarda en ambos sitios con un único botón; las pruebas cubren sync, borrados, cambio de servidor e interfaz.
- [x] M77-T1 Backend: `serverId` persistente en `zerochat.db` expuesto en `live_state`, `normalize_profile_id` unificado (`profile:<nombre>`) y `save_general_profile` conservando el `updatedAt` recibido (2026-11-17)
- [x] M77-T2 Navegador: evolucionar `profiles_v1` (lista única con `serverId`, `deletedIds` y `synced` por perfil), carga bajo demanda de API keys del servidor (`reveal`) y sincronización bidireccional al conectar conservando `updatedAt` (2026-11-17)
- [x] M77-T3 Navegador: detección de cambio de `serverId` al conectar y diálogo para elegir entre usar los perfiles del servidor o fusionar los actuales (2026-11-17)
- [ ] M77-T4 Interfaz y modos: selector único con switch superior de ejecución en segundo plano (deshabilitado para `Espejo` y `webllm`), botón único de Guardar en ambos repositorios, textos es/en y ayuda
- [ ] M77-T5 Pruebas de backend, sincronización por `updatedAt`, borrados (`synced` y `deletedIds`), cambio de `serverId` e interfaz del selector y editor
