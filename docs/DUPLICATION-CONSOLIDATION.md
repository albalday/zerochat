# Consolidación posterior a la extracción de módulos

## Situación revisada

Base: `c99c731`, rama `dev`. Antigravity extrajo compositor, perfiles, shell,
transferencias, reset, conversaciones, vista y controlador de generación.
`app.js` conserva integración, callbacks y fallbacks; el motor aún presenta DOM.
Este trabajo adapta `dupli.md` a esa situación y no completa ni rehace la
refactorización de arquitectura. La suite inicial pasa: 547 pruebas.

## Fases y puntos de retorno

Cada fase termina con build, suite completa, pruebas de navegador cuando
corresponda y commit/push a `dev`. Se preservan los cambios locales ajenos.

1. **Reglas de turnos:** `message-turns.js` concentra identificación de IDs,
   reconocimiento de mensajes iniciales de fecha y eliminación/saneamiento.
   Estado, motor, servicio y vista lo reutilizan. Se conservan las APIs públicas,
   el predicado de `State.removeTurn` y su bloqueo durante generación.
2. **Consultas y configuración:** centralizar lectura de modelos completados en
   WebLLM y retirar configuración de respaldo duplicada en el arranque.
3. **Presentación común:** compartir copia, errores de conexión y bloques de
   respuestas sin igualar los ciclos de historial y streaming.

## Diferencias conservadas deliberadamente

La inferencia del ID base en `State.removeTurn` usa la convención histórica de
los dos primeros segmentos; el motor elimina sufijos de turnos. Ambas fachadas
normalizan su selección antes de llamar al algoritmo común. Cambiar esa política
sería un cambio de comportamiento, no una deduplicación.

Se conserva asimismo la asociación histórica de resultados de herramientas con
el asistente inmediatamente anterior y su fallback por nombre. Revisar esa
política para grupos con varios resultados consecutivos requiere un cambio
funcional específico; no se altera durante esta consolidación.

## Validación de fase 1

Build correcto; `npm test`: 550 pruebas aprobadas; suite de navegador aprobada.
Se añadieron pruebas de inmutabilidad, selección, compatibilidad de las fachadas
y bloqueo durante generación. Las comprobaciones que lanzan Chromium o procesos
requieren ejecución fuera del sandbox de este entorno.

## Validación de fase 2

El proveedor WebLLM es propietario de la lectura y validación de metadatos de
modelos completados; inspector y perfiles conservan sus consultas públicas y la
prioridad del adaptador registrado. El fallback de Node utiliza `ChatStorage`
desde el proveedor, sin descargar el runtime WebLLM. El arranque requiere
`ChatConfig` y conserva el aviso ante un error de inicialización; no mantiene una
segunda tabla de valores predeterminados.

Build correcto; `npm test`: 555 pruebas aprobadas; 46 pruebas de navegador
aprobadas. Nuevas comprobaciones cubren JSON inválido, almacenamiento inaccesible,
metadatos cambiantes, adaptadores sustituidos, fallback Node y contrato de arranque.

## Consolidación de fase 3

`ui-conversation.js` posee creación/renderizado de bloques de asistente, cursor,
acción de copiar y tarjetas de error. Historial, motor y controlador utilizan esas
operaciones. `ChatEngine.injectStreamingCursor` conserva su interfaz como fachada.
Los bloques del historial y del streaming conservan su ciclo específico; las
tarjetas de herramientas siguen usando `tool-cards.js` y no se fusionan sus
operaciones en vivo e históricas.

La copia conserva la selección de texto de cada origen y su título traducido.
No muestra confirmación si el portapapeles no existe o rechaza la escritura;
captura los errores y permite retirar el handler y su temporizador. Los errores
de conexión comparten la misma vista en el resultado del motor y en excepciones,
escapando también la URL interpolada en la traducción.

Se retiran 14 funciones privadas sin llamadas en `app.js`, además de un alias
sin uso. Las APIs públicas y los callbacks de integración necesarios permanecen.
No se introduce un resolvedor genérico de dependencias: los resolutores existentes
soportan entornos y sustituciones distintos, y compartirlos no aporta una regla
de dominio común. Se mantienen las validaciones de UI y servicio en sus fronteras.

No se intenta completar aquí el desacoplamiento del motor respecto de UI,
rediseñar la finalización de generación ni convertir todo el arranque a async.
Son responsabilidades pendientes de la arquitectura previa, ajenas a esta
optimización de duplicaciones.

Build correcto; `npm test`: 561 pruebas aprobadas; 47 pruebas de navegador
aprobadas. Se comprueban ambos caminos de error del controlador, copia y fallos
del portapapeles, liberación de la acción, paridad entre historial y streaming,
retirada del cursor y escape de detalles remotos en DOM real.

Respecto a `c99c731`, los archivos JavaScript de aplicación tienen 257 líneas menos
en conjunto, incluido el nuevo módulo común. Las pruebas y documentación crecen
para cubrir los contratos conservados y las fronteras de presentación.
