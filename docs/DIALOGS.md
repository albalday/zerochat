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
la cola se restaura el foco. `ChatDialogs.confirm(message, options)` muestra Aceptar y Cancelar y devuelve
una promesa booleana. Solo Aceptar devuelve `true`; Cancelar, Escape, cierre o
cambio de conversación devuelven `false`. Cancelar recibe el foco inicial.
Las confirmaciones no se deduplican: cada acción requiere su propia decisión.
Los llamadores deben usar `await` y volver a comprobar las condiciones que
puedan cambiar mientras esperan antes de ejecutar la acción destructiva.
No se utilizan `alert()` ni `confirm()` nativos en la aplicación.

`await ChatDialogs.prompt(message, defaultValue = '', options = {})` solicita
texto y devuelve una cadena al aceptar (incluida la cadena vacía), o `null` al
cancelar, cerrar o cambiar de conversación. El campo recibe el foco y selecciona
el valor inicial. Enter acepta salvo durante composición de texto; Escape cancela.
El límite es de 10 000 caracteres. Los llamadores validan nombres vacíos y
coincidencias después de esperar el resultado. No se permite el `prompt()` nativo.
