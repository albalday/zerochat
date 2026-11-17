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
- [x] M76-T6 Aclarar en el aviso de Simplificar memoria que, además del modelo adecuado, conviene hacerla también con el agente o agentes que más hayan participado en la gestión del proyecto, porque solo ellos conocen lo que guardan en su memoria propia (2026-11-17)
- [x] M76-T7 El prompt de Simplificar memoria pide al agente revisar también su memoria propia del proyecto fuera del repositorio e incorporar con aprobación lo vigente que no esté registrado (2026-11-17)
- [x] M76-T8 Aclarar en el prompt de Simplificar memoria sus dos objetivos (compactar y consolidar lo no registrado, de memoria propia o de la conversación), los ID de lo incorporado, el destino de lo desactualizado y la exclusión de secretos (2026-11-17)

## M77 Almacenamiento unificado y selector de perfiles: closed 2026-11-17
