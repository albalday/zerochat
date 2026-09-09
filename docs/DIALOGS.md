# Avisos internos

Los avisos de la aplicación utilizan `ChatDialogs.alert(message, options)` en
`js/ui-dialogs.js`. `options` admite `title` y `type` (`info`, `success`, `error`).
Los textos se traducen con `ChatI18n` antes de enviarlos. El contenido se muestra
como texto, nunca como HTML.

La función devuelve una promesa que se resuelve al cerrar el aviso o al limpiar
la conversación. Usar `await` únicamente si la continuación requiere esperar
al usuario; los bloqueos de acciones deben seguir devolviendo su resultado de
forma síncrona. El diálogo no detiene la ejecución ni el streaming.

La cola reside en `ChatState.ui.notices` y se modifica mediante `enqueueNotice`
y `dismissNotice`. Se agrupan avisos pendientes idénticos y se admiten hasta
50 avisos diferentes; superar el límite produce un error explícito. Los mensajes
se limitan a 10 000 caracteres y los títulos a 200. Los cambios de conversación
limpian los avisos pendientes. No se persisten.

Aceptar o Escape cierran el aviso; pulsar el fondo no lo cierra. Al terminar
la cola se restaura el foco. Las confirmaciones `confirm()` mantienen su
comportamiento actual y quedan fuera de esta migración.
