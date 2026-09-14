# Orden de ejecución: partición funcional de `js/app.js`

## Objetivo

Refactorizar `js/app.js` para que sea el punto central de composición y arranque
de ZeroChat. Las funcionalidades específicas deben quedar autocontenidas en sus
módulos y ofrecer interfaces explícitas a los demás.

Este documento guarda el estudio y las instrucciones para una ejecución posterior.
Su creación no implica ejecutar ahora la refactorización.

El archivo objetivo es `js/app.js`, no `apps.js`. En el momento del estudio tiene
3.282 líneas. La modularización existe parcialmente, pero numerosos flujos,
decisiones y eventos de módulos especializados siguen concentrados en él.

## Alcance y condiciones

- Trabajar en `dev` y respetar `AGENTS.md` y los cambios existentes del usuario.
- Conservar comportamiento, interfaces públicas y compatibilidad con navegador,
  Node.js, `file://` y el bundle autónomo.
- Crear abstracciones cuando permitan separar una responsabilidad concreta;
  reutilizar primero los servicios equivalentes existentes.
- No introducir dependencias, un framework, un bus global de eventos ni un
  registro genérico de servicios para esta partición.
- No editar manualmente `zerochat.html`.
- Revisar el estado real del código antes de ejecutar: los nombres y puntos de
  extracción de este estudio pueden haber evolucionado.

## Responsabilidad final de `app.js`

Conservar una función central de arranque, por ejemplo `bootstrap()`, que:

1. Inicialice configuración, estado y persistencia.
2. Cree los servicios y las interfaces con dependencias explícitas.
3. Conecte las acciones entre módulos.
4. Espere la restauración inicial antes de habilitar operaciones dependientes.
5. Publique la API pública y gestione la liberación de recursos.

Extraer de `app.js` el catálogo global de elementos DOM, los handlers específicos,
el HTML de mensajes y las reglas de conversaciones, perfiles y generación.
No sustituirlos por un objeto global que vuelva a contener todas esas funciones.

Actualmente `init()` llama a `loadSessionsFromStorage()` sin esperar su resultado
y continúa registrando eventos. El arranque debe tener un contrato explícito de
disponibilidad y tratamiento de errores.

## Partición funcional

Los nombres nuevos son orientativos. Ajustarlos a las convenciones existentes sin
alterar las responsabilidades ni multiplicar abstracciones innecesariamente.

| Responsabilidad | Destino propuesto | Interfaz orientativa |
| --- | --- | --- |
| Crear, cargar, guardar, cambiar, borrar y ramificar conversaciones | Nuevo `conversation-service.js` | `create()`, `open(id)`, `save(id)`, `remove(id)`, `branch(selection)`, `import(data)` |
| Preparar y ejecutar un envío, cancelar y finalizar | Nuevo `generation-controller.js` | `send(input)`, `cancel()` |
| Mensajes, acciones, historial y presentación del streaming | Nuevo `ui-conversation.js` | `renderHistory()`, `beginResponse()`, `updateResponse()`, `finishResponse()` |
| Entrada de texto, pegado, archivos y arrastrar/soltar | Nuevo `ui-composer.js`, reutilizando `attachments.js` | `mount()`, `clear()`, `focus()`, acción `onSubmit` |
| Edición y gestión visual de perfiles, borradores y confirmaciones | Nuevo `ui-profiles.js` | `open()`, `close()`, `mount()`; reutilizar `profile-repository.js` |
| Configuración, apariencia y razonamiento | Completar `ui-settings.js` y `ui-reasoning.js` | Eventos y suscripciones propios |
| Sidebar y navegación entre conversaciones | Completar `ui-sidebar.js` | Acciones inyectadas de abrir, crear, borrar, renombrar y exportar |
| Exportación/importación y su diálogo | `export.js` para formatos; nuevo `ui-transfer.js` para el flujo | `openExport(id)`, `importFile(file)` |
| Telemetría, estado de generación y depuración | Completar los módulos existentes | Suscripciones y eventos propios |
| Borrado global y parada previa de operaciones | Nuevo `data-reset-service.js` | `reset()` con resultado detallado |
| Viewport e información de ejecución | Nuevo `ui-shell.js` | `mount()`, `openExecutionInfo()`, `dispose()` |

No crear otro repositorio de perfiles ni otro almacén de configuración.
`ProfileRepository`, `ChatConfig`, `ChatStorage` y `ZeroChatDB` ya cubren esas
responsabilidades. La extracción del borrado global no autoriza ampliar los datos
eliminados por el botón «Borrar todo».

## Contratos entre módulos

Conservar UMD y utilizar interfaces pequeñas con dependencias inyectadas.
Por ejemplo, el sidebar recibe las operaciones de conversaciones necesarias,
no todo `ChatApp`, todo el DOM ni funciones internas de otros módulos.

- Las acciones se realizan mediante llamadas explícitas y esperables, como
  `await conversations.open(id)`.
- El estado compartido permanece en `ChatState`, respetando sus slices canónicos
  y usando mutadores de dominio para las modificaciones.
- La presentación se suscribe a los campos de estado que necesita.
- Los recursos técnicos, como controladores de cancelación, listeners y
  referencias DOM, pertenecen a instancias con liberación explícita; no deben
  convertirse en estado compartido oculto ni provocar fugas entre conversaciones.
- Cada módulo visual monta sus propios eventos y ofrece `dispose()` para retirar
  listeners, suscripciones y recursos que posea.
- Los servicios de dominio reciben datos e identificadores, no nodos DOM ni
  eventos del navegador.
- Documentar para cada operación pública entradas, resultado, errores,
  cancelación y quién modifica el estado o persiste los datos.

Desmantelar progresivamente `setupEventListeners()`, que concentra alrededor de
550 líneas en el momento del estudio. Evitar dependencias circulares: los módulos
especializados no deben llamar de vuelta a `app.js` para ejecutar su lógica.

## Fronteras que requieren atención

### Generación y presentación

`handleSendMessage()` mezcla adjuntos, configuración, credenciales, RAG,
ejecución, HTML, estadísticas y guardado. Extraer el ciclo de envío al controlador
de generación y la presentación al módulo visual.

La separación completa también requiere revisar `chat-engine.js`, que crea y
actualiza DOM, y `agent-core.js`, cuya ejecución de herramientas presenta tarjetas.
Trasladar esa presentación a un adaptador visual aprovechando los callbacks
existentes. El motor debe trabajar con datos y notificaciones de ejecución.
Preservar los contratos de herramientas de `docs/TOOLS.md` y sus validaciones.

Conservar el renderizado eficiente durante SSE. No reconstruir el historial ni
actualizar paneles y popovers pesados con cada token como consecuencia de nuevas
suscripciones. Mantener el formato y las acciones de tarjetas de herramientas,
tanto en vivo como al restaurar conversaciones.

### Conversaciones y selección visual

Actualmente ramificar recibe un `wrapper` y deduce los mensajes mediante
atributos HTML. La vista debe traducirlo a una selección de identificadores.
El servicio valida esa selección y construye la rama sin conocer el DOM.

Conservar agrupaciones de turnos, relaciones entre llamadas y resultados de
herramientas, ancla de fecha, metadatos, adjuntos y reglas de títulos.
Revalidar sesión y selección después de esperas cuando puedan haber cambiado.

### Propiedad de la operación activa y persistencia

Cada generación debe tener identidad propia, asociada a sesión y turno.
Sus callbacks y su finalización solo pueden modificar la operación que les
pertenece. La configuración usada en un turno debe seguir siendo una instantánea
estable aunque se cambie el perfil.

La finalización debe esperar el guardado y manejar su resultado. Actualmente
`finishGeneration()` llama a `saveCurrentSession()` sin `await`, por lo que su
`try/catch` no captura rechazos posteriores. Revisar también los resultados de
persistencia que indiquen fallo sin lanzar una excepción.

No mutar directamente mensajes obtenidos de `ChatState`: usar copias de trabajo
y confirmar mediante mutadores específicos. Separar el resultado de la ejecución
de su confirmación en el estado y de su persistencia.

### Perfiles y configuración activa

Mantener el borrador separado de la configuración publicada. Actualmente parte
del estado del editor está en `dataset.queryReady` y en propiedades del input de
credenciales. Dar al editor un modelo explícito en `ChatState.ui`, evitando
duplicar secretos innecesariamente.

Conservar consulta del proveedor, validación para guardar, detección de cambios,
cancelación del cierre, selección del perfil y carga asíncrona de credenciales.
Una respuesta tardía no debe sobrescribir otro perfil o un borrador posterior.

## Fases de ejecución

1. **Inventario y contratos.** Revisar dependencias, funciones públicas, pruebas
   y responsabilidades existentes. Identificar los consumidores de `ChatApp` y
   definir los límites concretos antes de extraer código.
2. **Módulos visuales delimitados.** Extraer perfiles, compositor, sidebar y
   transferencia de conversaciones. Completar eventos y suscripciones de
   configuración, razonamiento, telemetría y depuración. Separar shell y reset.
3. **Servicio de conversaciones.** Extraer operaciones de dominio y persistencia,
   retirando las dependencias de elementos DOM.
4. **Generación y renderizado.** Extraer el controlador de generación y la vista
   de conversación. Desacoplar la presentación de motor y ejecución de
   herramientas, conservando sus contratos durante la transición.
5. **Composición final.** Reducir `app.js` al arranque, conexión de dependencias,
   ciclo de vida y fachada pública. Eliminar delegaciones y fallbacks transitorios
   que ya no sean necesarios, tras comprobar sus consumidores.
6. **Validación y documentación.** Completar las comprobaciones aplicables,
   actualizar la documentación afectada y regenerar el bundle.

Hacer extracciones pequeñas y verificables, sin introducir funcionalidades ajenas.
Mantener temporalmente `window.ChatApp` como fachada de compatibilidad: las pruebas
de navegador utilizan métodos de sesiones, ramificación, idioma, exportación,
información de ejecución y estado de generación. No eliminar interfaces públicas
sin una decisión explícita.

## Validación y criterios de aceptación

- `app.js` compone e inicializa; no contiene reglas específicas de los módulos.
- Cada funcionalidad puede probarse y utilizarse sin cargar `app.js`.
- Cada módulo posee sus eventos y ofrece una interfaz pública acotada.
- El estado compartido tiene una única fuente de verdad en `ChatState`.
- El arranque asíncrono y la liberación de recursos tienen contratos verificables.
- No hay listeners duplicados, resultados tardíos aplicados a otra conversación
  ni guardados fallidos ignorados.
- Se conservan cancelación, restauración, borrado y ramificación con herramientas,
  borradores de perfiles, credenciales, adjuntos, importación/exportación y SSE.
- Las pruebas unitarias ejercitan servicios con dependencias controladas; las de
  navegador verifican integración y compatibilidad de la fachada existente.
- Se mantienen los textos bilingües y los diálogos de `ChatDialogs`.
- Pasan las pruebas aplicables, `npm test` y `npm run test:browser` por afectar
  a DOM y eventos; no aparecen errores de consola en las pruebas de navegador.
- Se ejecuta `npm run build` y se comprueba la actualización de `zerochat.html`.
- Se actualiza la documentación de arquitectura afectada y se mantiene `/help`
  coherente y bilingüe cuando corresponda.

El éxito se mide por responsabilidades independientes y contratos claros, no por
alcanzar un número arbitrario de archivos o líneas.
