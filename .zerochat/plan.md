# Plan

<!-- Hitos M1 a M69 archivados en .zerochat/archive/ -->

## M70 Arreglos de run_command: closed 2026-11-14

## M71 Navegador de ficheros del proyecto: closed 2026-11-14

## M72 Catálogo de servicios MCP con versión independiente: closed 2026-11-16

## M73 Arreglos de seguridad: closed 2026-11-15

## M74 Arreglos multiplataforma de la 10.19.0: closed 2026-11-16

## M75 Arreglos menores

Goal: Que el icono de chat nuevo de un proyecto del historial cambie de proyecto también desde un chat vacío y que las conversaciones con «Ejecutar en servidor» queden siempre en el historial, aunque se cierre el navegador o la ejecución no termine.
Done when: el icono de chat nuevo de otro proyecto lleva a ese proyecto con un chat vacío abierto; una ejecución en servidor guarda la conversación en SQLite a cada paso y la interfaz la muestra desde lo grabado, terminada o no, tras cerrar y reabrir el navegador; sin controles que dejen de grabar por la conexión con la interfaz.
- [ ] M75-T1 El icono de chat nuevo de un proyecto del historial no hace nada si ya hay un chat vacío abierto: reproducir y corregir, con prueba
- [x] M75-T2 Analizar el flujo de grabación de las ejecuciones en servidor (runner, servidor de la ejecución, servidor principal e interfaz) y por qué se pierden conversaciones al cerrar el navegador (2026-11-16)
- [x] M75-T3 El runner de Node graba la conversación en SQLite al terminar cada paso (assistant con sus tool), no solo al final del turno: una ejecución que muere, agota un plazo o se cancela conserva lo hecho; prueba con Node real (2026-11-16)
- [x] M75-T4 Quitar los plazos que cortan la ejecución por la interfaz (sin progreso 600 s y total 900 s) y dejar solo el final del runner y la cancelación del usuario (2026-11-16)
- [x] M75-T5 El fichero de estado de una ejecución queda en estado, paso y error, sin el texto vivo (assistant_text, reasoning_text), y focus_run lleva la fecha de la conversación grabada (conversation_updated_at) (2026-11-16)
- [x] M75-T6 La interfaz solo consulta el estado (cada 2 s) con una conversación de servidor en marcha abierta y la recarga desde lo grabado cuando cambia su fecha; al cambiar de conversación no consulta nada y al volver se trae entera y reanuda (2026-11-16)
