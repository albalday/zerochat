# Plan

<!-- Hitos M1 a M69 archivados en .zerochat/archive/ -->

## M70 Arreglos de run_command: closed 2026-11-14

## M71 Navegador de ficheros del proyecto: closed 2026-11-14

## M72 Catálogo de servicios MCP con versión independiente: closed 2026-11-16

## M73 Arreglos de seguridad: closed 2026-11-15

## M74 Arreglos multiplataforma de la 10.19.0: closed 2026-11-16

## M75 Arreglos menores: closed 2026-11-16

## M76 Ajustes de perfiles

Goal: Que los perfiles se elijan, se editen y asignen sus servicios MCP desde un único sitio, sea el perfil local o del servidor y esté o no activo «Ejecutar en servidor», con una nomenclatura única.
Done when: los servicios MCP de un perfil se asignan en un solo sitio; un perfil del servidor se edita sin salir de «Ejecutar en servidor»; perfiles, modos y textos usan los mismos nombres en código, interfaz (es y en) y ayuda; Brave, con un servidor recién arrancado, aplica replaces, enabledByDefault y rateLimit en el chat y en «Ejecutar en servidor».
- [ ] M76-T1 Analizar y proponer un modelo único: dónde se asignan hoy los servicios MCP (capítulo Servidores MCP del perfil, Ajustes › MCP con Iniciar y recordar), cómo se elige el perfil (selector local, «Ejecutar en servidor», perfiles del servidor) y qué servicios arranca una ejecución en servidor
- [ ] M76-T2 Asignar los servicios MCP de un perfil (local o del servidor) en un único sitio
- [ ] M76-T3 Editar y mantener los perfiles del servidor sin salir del modo «Ejecutar en servidor»
- [ ] M76-T4 Normalizar la nomenclatura de perfiles (local, del servidor, de sesión, general, prefijo Z-) en código, interfaz es y en, y ayuda
- [ ] M76-T5 Comprobar con un servidor recién arrancado que Brave aplica replaces, enabledByDefault y rateLimit en el chat y en «Ejecutar en servidor», y corregir lo que falle
