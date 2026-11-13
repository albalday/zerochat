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

## M63 Cambios pequeños y pruebas

Goal: Corregir fallos pequeños detectados en el uso tras los últimos hitos y probar a mano lo cambiado.
Done when: Las tareas del hito están hechas, probadas en el navegador y todos los niveles de §4 pasan en verde.
- [x] M63-T1 Editar un perfil de servidor sin cambiar nada deja cerrar el editor sin preguntar; Guardar en local sigue importándolo (2026-11-13)
- [x] M63-T2 En móvil los botones de guardar del editor de perfiles muestran solo el icono para que la cabecera no se desborde (2026-11-13)
- [x] M63-T3 Cabecera de proyecto destacada en el historial (icono de carpeta, línea separadora, nombre en el color del texto y número de conversaciones) para distinguirla de los chats y de las cabeceras de fecha (2026-11-13)
- [x] M63-T4 Grupos de proyecto plegables en la vista "Todos": plegados por defecto salvo el de la conversación abierta; el estado plegado se recuerda por navegador (localStorage, tolerante a fallos) y se maneja con teclado (botón con aria-expanded) (2026-11-13)
- [x] M63-T5 La búsqueda del historial conserva las cabeceras de proyecto: muestra solo los grupos con coincidencias, desplegados mientras haya texto, y "Sin proyecto" al final (2026-11-13)
- [ ] M63-T6 Límites del historial sin borrado: medir con 2000 conversaciones el coste de conversations/list, de la sincronización completa a IndexedDB al conectar y del pintado de la barra; proponer en docs/ los topes o la carga diferida necesarios y abrir sus tareas tras decidir con el usuario
- [x] M63-T7 La barra no pinta las conversaciones de los grupos plegados; desplegar un grupo lo pinta (corrige M63-T4: 270 000 nodos ocultos con 10 000 conversaciones) (2026-11-13)
- [x] M63-T8 Tope de 50 conversaciones pintadas por grupo con botón "Mostrar N más"; la búsqueda sigue recorriendo todos los títulos (prueba en 50 y 51) (2026-11-13)
- [ ] M63-T9 Borrar historial con un proyecto activo pregunta por las conversaciones de ese proyecto, con casilla para borrar todo; el servidor borra por proyecto y cancela solo las ejecuciones de esas conversaciones
- [ ] M63-T10 Al conectar se sincronizan solo las cabeceras: la lista aparece en cuanto llega conversations/list y cada conversación se descarga a IndexedDB al abrirla; sin servidor, una no descargada avisa en vez de abrirse vacía
