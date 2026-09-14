# Prompt: consolidación de duplicaciones tras la refactorización

Actúa como responsable de una optimización posterior a la partición funcional
descrita en `apps.md`. Analiza y elimina duplicaciones reales en ZeroChat,
manteniendo el comportamiento, las interfaces públicas y los límites entre módulos.

Este trabajo es independiente y posterior a la refactorización. Antes de editar,
lee `AGENTS.md` y `apps.md` y comprueba el estado actual del repositorio. Si la
partición todavía no está completada, informa de ello y no la ejecutes como parte
de esta optimización. Las ubicaciones siguientes corresponden al estudio previo
y pueden haber cambiado: localiza sus equivalentes actuales.

## Objetivo

Cada regla de dominio debe tener una implementación propietaria, reutilizada por
sus consumidores. Reducir lógica repetida y puntos de mantenimiento; no limitarse
a trasladar funciones ni perseguir un número arbitrario de líneas o archivos.

## Candidatos identificados

1. **Identificación de turnos.** `extractBaseId()` aparecía en `app.js` y
   `chat-engine.js`. Consolidar su implementación en el módulo propietario de la
   lógica de turnos.
2. **Eliminación y saneamiento de turnos.** `ChatState.removeTurn()` y
   `ChatEngine.removeTurnFromHistory()` contienen algoritmos solapados. Comparar
   primero sus diferencias de selección y asociación entre llamadas y resultados
   de herramientas. Si procede, compartir un algoritmo puro, manteniendo la
   autorización y modificación atómica en los mutadores de `ChatState`.
3. **Modelos WebLLM completados.** `app.js`, `ui-inspector.js` y el proveedor
   interpretaban el almacenamiento de modelos completados. Centralizar esa
   consulta en el proveedor y hacer que los consumidores utilicen su interfaz.
   Retirar fallbacks únicamente cuando se haya comprobado que no son necesarios
   para compatibilidad ni para los entornos soportados.
4. **Presentación de respuestas.** `app.js` y `chat-engine.js` creaban bloques de
   respuesta. Reutilizar componentes visuales comunes para historial y streaming,
   respetando sus ciclos diferentes y el renderizado incremental eficiente.
5. **Acción de copiar.** La copia y su confirmación visual se repetían para
   respuestas nuevas y restauradas. Compartir la interacción visual sin alterar
   qué contenido corresponde copiar en cada caso, ni su tratamiento de errores.
6. **Errores de conexión.** Dos caminos del envío construían una tarjeta de error
   similar. Consolidar el renderizador manteniendo el contexto, la traducción y
   el tratamiento seguro de contenido externo.
7. **Configuración predeterminada.** `app.js` mantenía valores de respaldo además
   de los canónicos de `config-store.js`. Utilizar la fuente canónica y declarar
   las dependencias obligatorias, sin cambiar silenciosamente los valores ni
   degradar la gestión de errores de arranque.
8. **Delegaciones y comprobaciones repetidas.** Revisar wrappers que solo delegan
   y resoluciones repetidas de dependencias. Eliminar los que ya no sean necesarios
   después de la partición, conservando las fachadas públicas usadas por otros
   módulos o pruebas.

Esta lista contiene candidatos, no órdenes de fusionar automáticamente. Registrar
cuáles siguen existiendo, cuáles ya resolvió la refactorización y cuáles deben
permanecer separados por diferencias de comportamiento.

## Límites de diseño

- No confundir validación en distintas fronteras con duplicación prescindible:
  validar un formulario no sustituye la validación de entradas en el servicio.
- No unificar bloques solo porque se parecen. Compartir lo que representa la
  misma regla y preservar explícitamente las diferencias semánticas.
- Evitar abstracciones genéricas con numerosas opciones o condicionales que
  resulten más complejas que las implementaciones originales.
- Ubicar cada implementación común en su módulo propietario. No convertir
  `app.js` ni un archivo de utilidades en un contenedor indiscriminado de lógica.
- Conservar la separación entre dominio, presentación, proveedores y persistencia.
- Mantener UMD, las interfaces públicas y la compatibilidad con navegador,
  Node.js, `file://` y el bundle autónomo.
- Conservar `ChatState` como fuente del estado compartido y usar sus mutadores
  específicos. No introducir copias de estado compartido ocultas en módulos.
- No añadir dependencias ni ampliar el alcance funcional de la aplicación.
- No reducir controles de seguridad, cancelación, errores, internacionalización
  o liberación de recursos para disminuir líneas.

## Procedimiento

1. Trabaja en `dev`, respeta `AGENTS.md` y preserva cambios existentes del usuario.
2. Inventaría las duplicaciones actuales y sus consumidores. Contrasta contratos
   y comportamiento antes de elegir una implementación común.
3. Prioriza duplicaciones de reglas y comportamiento sobre repeticiones triviales.
4. Consolida en cambios pequeños. Conserva adaptadores de compatibilidad cuando
   sean necesarios y elimina código sustituido solo tras revisar sus referencias.
5. Comprueba casos relevantes: eliminación de turnos con varias herramientas,
   historial restaurado, streaming, cancelación, consulta de modelos incompletos,
   copia de respuestas y errores de proveedores, según el candidato modificado.
6. Ejecuta las pruebas aplicables y las comprobaciones exigidas por `AGENTS.md`:
   `npm test`, pruebas de navegador si se afecta HTML/CSS/DOM y `npm run build`.
   No edites `zerochat.html` manualmente; verifica su regeneración.
7. Mantén documentación y ayuda bilingüe coherentes cuando corresponda.

## Entrega y aceptación

Entrega un resumen de duplicaciones eliminadas, implementación propietaria y
consumidores actualizados. Explica las candidatas que decidiste no consolidar.
Indica las pruebas ejecutadas y cualquier limitación pendiente.

La optimización se acepta cuando conserva el comportamiento, reduce puntos de
mantenimiento y respeta las fronteras establecidas por la refactorización.
Algunos módulos pueden crecer al asumir lógica común. El total de líneas puede
incluir nuevas interfaces y pruebas: no prometas un porcentaje de reducción ni
confundas menor tamaño de `app.js` con menor complejidad del conjunto.
