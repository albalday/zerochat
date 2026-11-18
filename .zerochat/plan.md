# Plan

<!-- Hitos M1 a M69 archivados en .zerochat/archive/ -->

## M70 Arreglos de run_command: closed 2026-11-14

## M71 Navegador de ficheros del proyecto: closed 2026-11-14

## M72 Catálogo de servicios MCP con versión independiente: closed 2026-11-16

## M73 Arreglos de seguridad: closed 2026-11-15

## M74 Arreglos multiplataforma de la 10.19.0: closed 2026-11-16

## M75 Arreglos menores: closed 2026-11-16

## M76 Ajustes de perfiles: closed 2026-11-17

## M77 Almacenamiento unificado y selector de perfiles: closed 2026-11-17

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora

Goal: Mejorar el navegador de ficheros del proyecto y el uso de chats sin proyecto con el backend conectado, y conservar las propuestas de mejora de usabilidad, funcionalidad y solidez para decidirlas una a una con el usuario.
Done when: las tareas del navegador de ficheros y de chats sin proyecto están hechas o descartadas, y cada propuesta está implementada o marcada como descartada con su motivo.
- [x] M79-T1 Navegador de ficheros: tamaño de letra ajustable en la vista de ficheros de texto (2026-11-18)
- [x] M79-T2 Navegador de ficheros: descargar cualquier fichero, también los de texto, además de abrirlo (2026-11-18)
- [x] M79-T3 Navegador de ficheros: decidir con el usuario si los .html se abren renderizados y cómo aislarlos del origen de la aplicación (dropped: no aporta suficiente valor frente a la vista de texto)
- [x] M79-T4 Navegador de ficheros: decidir con el usuario un editor pequeño de ficheros de texto con guardado por el backend sujeto a las reglas de directorio (dropped: editar ficheros se hace fácilmente pidiéndoselo al agente)
- [x] M79-T5 Navegador de ficheros: decidir con el usuario borrar ficheros con confirmación y sujeto a las reglas de directorio (dropped: borrar ficheros se hace fácilmente pidiéndoselo al agente)
- [x] M79-T6 Decidir con el usuario y permitir usar chats sin proyecto cuando hay conexión con el backend (2026-11-18)
- [ ] M79-T7 Propuesta: buscar en el contenido de las conversaciones, no solo en el título (FTS5 en el servidor, IndexedDB sin él)
- [ ] M79-T8 Propuesta: regenerar una respuesta y editar una pregunta en su sitio creando rama automáticamente
- [ ] M79-T9 Propuesta: atajos de teclado (nueva conversación, buscar con Ctrl+K, detener con Esc, chuleta con ?)
- [ ] M79-T10 Propuesta: aviso en el título o el icono de la pestaña cuando un turno termina o pide permiso en segundo plano, sin la API Notification
- [ ] M79-T11 Propuesta: prompts guardados, globales o por proyecto, insertables con / en el compositor
- [ ] M79-T12 Propuesta: asistente de primer perfil con detección bajo petición de servidores locales y tabla de qué funciona en navegador y en servidor
- [ ] M79-T13 Propuesta: copia de seguridad y restauración del almacén del servidor (zerochat --backup y --restore)
- [ ] M79-T14 Propuesta: RAG híbrido opcional con /v1/embeddings del servidor de modelos fusionado con Orama
- [ ] M79-T15 Propuesta: batería de evaluación del agente con zerochat --prompt contra modelos locales, sin ajustes por modelo
- [ ] M79-T16 Propuesta: control de concurrencia entre pestañas con versión por conversación y 409 al guardar sobre una versión antigua
- [ ] M79-T17 Propuesta: comprobación de tipos con JSDoc y tsc --checkJs --noEmit en estado, almacenamiento y bucle del agente
- [x] M79-T18 Almacenamiento: readConversation debe comparar updatedAt entre la copia del backend y la local en vez de dar siempre la razón al backend, para no perder mensajes editados en modo normal (2026-11-18)
- [ ] M79-T19 Documentar en AGENTS.md los comandos de .zerochat/task.py (add-task, done, status) para que los agentes lo usen en lugar de editar a mano .zerochat/plan.md
- [x] M79-T20 Panel de razonamiento: facilitar crear un proyecto nuevo y cambiar de proyecto desde el propio panel (2026-11-18)
- [ ] M79-T21 Diálogo de permisos: mostrar la línea completa del comando o de la acción en vez de truncarla
- [x] M79-T22 Historial: selector de proyecto siempre visible con el actual, no-project y Todos los proyectos, que muestra todos los grupos plegados (2026-11-18)
- [x] M79-T23 Crear un chat en no-project estando conectado desde su cabecera del historial y desde el cambio de proyecto de T20 (2026-11-18)
- [x] M79-T24 Renombrar la carpeta de los chats sin proyecto de no-project a general (~/zerochat/general) (2026-11-18)
- [x] M79-T25 Backend: zerochat/project/browse (solo subcarpetas no ocultas, con tope y aviso) y zerochat/project/create_directory (solo bajo ~), sin acceso para la credencial del runner (2026-11-18)
- [x] M79-T26 Diálogo para elegir la carpeta de trabajo: ruta pegada, recientes con general fija, navegación por carpetas y nueva carpeta (2026-11-18)
- [x] M79-T27 Propuesta de simplificación de los diálogos entre frontend y backend (reducir y unificar llamadas, mejorar estabilidad y simplificar código) (2026-11-18)
- [x] M79-T28 Unificar el transporte en / (retirar /mcp/external y el segundo McpClient) y entregar tools, externalTools y policies en initialize, set_directory y servers/* (2026-11-18)
- [x] M79-T29 Contexto del proyecto en una sola llamada silenciosa (zerochat/project/context, e incluido en initialize y set_directory) en lugar de 3 tools/call read_file (2026-11-18)
- [x] M79-T30 Unificar consultas de comandos: zerochat/jobs/log con tail y detalles del comando, y jobs en marcha en zerochat/jobs/stop (2026-11-18)
- [x] M79-T31 Navegador bajo demanda, caché de rutas de Playwright en BrowserEngines, config en engines/list|remove y sin rebote checking en Ajustes › MCP (2026-11-18)
- [x] M79-T32 Evitar llamadas redundantes en blobs (caché en memoria de blobId sincronizados) y en recargas de sesiones al conectar o terminar ejecuciones (2026-11-18)
- [x] M79-T33 Revisión de higiene y calidad del código de M79: retirar zerochat/browser/config/get y ramas muertas, fijar caché de blobs por PROXY_ID y sincronizar README (2026-11-18)
