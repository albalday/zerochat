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

## M68 Arreglos pequeños 2: closed 2026-11-14

## M69 Esperas y comandos a la vista: closed 2026-11-14

## M70 Arreglos de run_command: closed 2026-11-14

## M71 Navegador de ficheros del proyecto

Goal: Que la persona pueda recorrer los ficheros del proyecto desde la interfaz: un icono de carpeta en la cabecera de cada proyecto del historial abre en una pestaña nueva una lista navegable de carpetas y ficheros; un fichero de texto se abre en otra pestaña y uno binario se descarga, sin edición ni comandos de momento.
Done when: `zerochat/files/list`, `zerochat/files/read` y `zerochat/files/download` solo alcanzan la carpeta del proyecto (ni `..` ni un enlace simbólico salen de ella) y sus topes tienen prueba en N y N+1; `files.html` conecta con la sesión guardada y el proyecto de su URL, lista carpetas primero con su icono, ficheros con tamaño y fecha, y navega con el historial del navegador; un fichero de texto se abre en una pestaña nueva y uno binario o demasiado grande se descarga; la cabecera de cada proyecto del historial tiene su icono de carpeta junto al de nuevo chat; ayuda en español e inglés y contratos al día, y pasan las pruebas aplicables (§4).
- [x] M71-T1 Servidor: `zerochat/files/list`, `zerochat/files/read` y `zerochat/files/download` contenidos en la carpeta del proyecto de la petición, con detección de texto o binario por el comienzo del fichero, descarga por páginas en base64 y topes de entradas por carpeta y de tamaño; pruebas de escape con `..` y enlaces simbólicos y de los topes en N y N+1 (2026-11-14)
- [x] M71-T2 Página base `files.html` y `js/files-page.js`: conecta con la sesión guardada (cookie) y el proyecto de la URL cargando solo lo necesario, muestra los errores de servidor sin conectar o carpeta inexistente, entra en el precache del service worker y tiene sus textos en `js/i18n.js` (es/en) (2026-11-14)
- [ ] M71-T3 Lista navegable: migas para subir, carpetas primero con su icono, ficheros con tamaño y fecha, navegación con el historial del navegador (atrás y adelante) y diseño que funcione en el móvil
- [ ] M71-T4 Abrir y descargar: un fichero de texto se abre en una pestaña nueva como texto plano; uno binario o demasiado grande se descarga por páginas; pruebas en `tests/browser/`
- [ ] M71-T5 Icono de carpeta en la cabecera de cada proyecto del historial, junto al de nuevo chat (`js/ui-sidebar.js`), que abre `files.html` de ese proyecto en una pestaña nueva; título accesible en es/en
- [ ] M71-T6 Ayuda bilingüe del navegador de ficheros y contratos en `py/README.md` y `js/README.md`
