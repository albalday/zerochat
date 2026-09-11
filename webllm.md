# Plan de integración de WebLLM

## Objetivo y alcance

Integrar WebLLM como un nuevo tipo de servidor, `apiType: "webllm"`, limitado a:

- la definición y consulta de perfiles de conexión;
- el envío de peticiones y la recepción de respuestas del chat.

El resto de la aplicación debe permanecer sin personalizaciones específicas de WebLLM: agentes, herramientas, RAG, renderizado, sesiones y telemetría seguirán consumiendo el contrato normal de `ChatAPI.streamChatCompletion()`.

La integración no contactará un servidor de inferencia: al usar este perfil, la inferencia se ejecutará localmente en el navegador mediante JavaScript y WebGPU.

## Archivos y responsabilidades

| Archivo | Cambio previsto |
| --- | --- |
| `js/profile-repository.js` | No requiere un esquema nuevo: el perfil ya persiste `apiType`, `apiUrl` y `model`. |
| `js/ui-settings.js` | Añadir WebLLM al selector de tipo y los controles de descarga dentro del editor de perfil. |
| `js/ui-inspector.js` | Adaptar la consulta de modelos del perfil para mostrar progreso y disponibilidad local. |
| `js/providers.js` | Registrar `WebLLMProviderAdapter`, extendiendo `BaseProviderAdapter`. |
| `js/api.js` | Delegar descubrimiento de modelos y transporte local al adaptador, conservando la ruta HTTP para los demás proveedores. |
| `js/providers-webllm.js` | Nuevo módulo UMD que encapsule carga del JavaScript, caché, catálogo, descarga de modelos y ejecución WebLLM. |
| `js/app.js` | Conectar únicamente los controles del perfil existentes con el módulo correspondiente. |
| `index.html`, `js/i18n.js` y CSS asociado | Incluir el módulo y añadir textos español/inglés y estilos del editor. |
| `tests/` | Cubrir el comportamiento nuevo y las regresiones de proveedores existentes. |

El archivo `zerochat.html` es generado y solo se actualizará con `npm run build` al final.

## Perfil WebLLM

Al seleccionar WebLLM en el editor de perfil:

- se guardará `apiType: "webllm"`;
- `apiUrl` usará el identificador interno `webllm://local`;
- el campo se mostrará como ejecución local y no será editable;
- el campo de API key quedará deshabilitado;
- se conservarán modelo, temperatura y las demás opciones de perfil ya existentes;
- se mostrará un texto localizado: «Ejecución local en este navegador».

Elegir el tipo no descargará nada. La descarga del JavaScript empezará únicamente al pulsar **Query**. El perfil se podrá guardar después de una consulta satisfactoria aunque el modelo elegido todavía no se haya descargado.

## Query y carga de WebLLM

La acción Query del perfil WebLLM seguirá esta secuencia:

1. Comprobar WebGPU y las APIs de almacenamiento requeridas.
2. Importar desde el CDN la versión fijada de WebLLM, una vez por pestaña.
3. Cargar su configuración precompilada.
4. Consultar el catálogo de modelos y el estado local de cada uno.

El estado del editor informará de forma breve:

```text
Descargando WebLLM… 4,2 MB
Preparando WebLLM…
WebLLM preparado. Modelos disponibles: …
```

El módulo remoto queda fijado a una versión concreta. Su caché HTTP pertenece al navegador y es independiente de IndexedDB, donde WebLLM conserva los artefactos de modelos. ZeroChat no implementa actualmente una descarga propia ni una comprobación de integridad adicional del módulo JavaScript.

## Catálogo y estado de modelos

La fuente del catálogo será `webllm.prebuiltAppConfig.model_list` de la misma versión de WebLLM cargada. No se mantendrá una lista manual ni se consultará `/v1/models`.

Cada modelo se convertirá al formato consumido por el selector existente, manteniendo su identificador exacto. El editor presentará, además del selector, una lista compacta:

| Modelo | Estado local | Acción |
| --- | --- | --- |
| Identificador del modelo | No descargado | Descargar |
| Identificador del modelo | Descargado | — |
| Identificador del modelo | Descargando, 46 % | Cancelar |

Cuando los metadatos lo publiquen, se mostrará el requisito estimado de VRAM. Esa cifra no se presenta como tamaño de descarga ni como garantía de memoria disponible.

Para conocer el estado inicial se combina `hasModelInCache(modelId, appConfig)` con un registro local escrito únicamente después de que el motor haya terminado de preparar el modelo. Si existen tensores sin ese registro, el estado es «Incompleto»; si no puede consultarse el almacenamiento, es «No comprobado». La ejecución solo acepta el estado confirmado. La API pública de WebLLM no permite inspeccionar de forma independiente cada artefacto auxiliar, por lo que una eventual eliminación parcial por parte del navegador se detectará definitivamente cuando WebLLM intente abrir el modelo.

La lista se volverá a comprobar en cada Query; no se persistirá un booleano de descarga dentro del perfil.

## Descargar modelos

El botón Descargar crea el motor mediante la API oficial. `initProgressCallback` se normaliza a fases estructuradas y actualiza el estado y la barra de progreso. Como esta operación descarga y prepara recursos, el texto es «Descargando y preparando…», sin atribuir todo el tiempo a la transferencia.

El motor se ejecutará en un Web Worker privado del adaptador para no bloquear la interfaz. El worker será un detalle interno del proveedor.

Reglas de operación:

- una sola preparación activa en el gestor del proveedor;
- cancelar termina el worker de esa operación y deja el modelo como incompleto;
- una descarga interrumpida no se mostrará como completa;
- al terminar se conserva el motor si el modelo continúa activo, para evitar otra carga antes del primer mensaje;
- si se cambia de perfil durante la operación, su resultado no podrá modificar el nuevo perfil;
- los errores de espacio, red o GPU aparecerán en el panel y permitirán reintentar.

## Proveedor y transporte del chat

Se añadirá `WebLLMProviderAdapter` al registro de `js/providers.js`, con capacidades declaradas por modelo. No debe anunciar razonamiento, herramientas, visión o JSON para modelos que no lo soporten.

`ChatAPI.streamChatCompletion()` añadirá un punto de delegación:

```text
ChatAPI.streamChatCompletion()
  → adaptador construye el payload
  → transporte del adaptador si existe; fetch HTTP para el resto
  → procesamiento de respuesta existente
  → callbacks actuales del chat
```

Para WebLLM el transporte:

1. comprueba que el modelo seleccionado está disponible localmente;
2. inicializa el motor con dicho modelo desde caché;
3. llama a `engine.chat.completions.create({ …payload, stream: true })`;
4. convierte su `AsyncIterable` de chunks en el formato que consume el lector actual, incluyendo el final `[DONE]` si se usa el puente SSE.

WebLLM expone chunks compatibles con completions estilo OpenAI. El puente permitirá reutilizar los callbacks de texto, razonamiento, herramientas, estadísticas y finalización sin duplicar la lógica de chat. No habrá un servidor HTTP local ni solicitudes de chat al CDN.

Se mantendrán `onBeforeRequest`, edición o cancelación desde el depurador, botón Detener, `AbortSignal`, limpieza, errores y callbacks existentes. Los parámetros incompatibles se filtrarán antes de invocar WebLLM; por ejemplo, no se enviará automáticamente `reasoning_effort`.

Si el modelo no está descargado, el envío devolverá un error localizado que indique descargarlo desde el perfil. El chat no iniciará una descarga larga y oculta.

## Estado y aislamiento

El catálogo, el contexto del editor y la operación visible se mantienen en `ChatState.ui.webllm`. Los recursos no serializables —worker, motor y `GPUDevice`— pertenecen a un gestor privado del adaptador.

El gestor conserva un único motor mientras se use el mismo modelo. Cambiar de proveedor, cambiar de modelo, borrar el modelo o cancelar su preparación libera el recurso. El historial continúa llegando explícitamente en cada petición, por lo que el motor no conserva una conversación oculta.

Se intenta primero el worker privado. Si el worker no llega a arrancar y no ha emitido progreso, se usa el motor en la pestaña como compatibilidad basada en capacidades. Los errores posteriores de modelo, almacenamiento o GPU se propagan sin repetir la preparación en otro modo.

Antes de considerar compatible el proveedor se probará desde el modo habitual de la aplicación y, si el proyecto lo soporta, desde `file://`. WebGPU, caché y workers se comprobarán en navegador real. Cuando falte una capacidad, el perfil explicará el motivo concreto.

## Pruebas y aceptación

Se añadirán o ajustarán pruebas para:

- carga diferida del módulo JavaScript;
- catálogo de modelos y estado descargado, incompleto o desconocido;
- progreso, cancelación y reintento de descarga;
- cambio de perfil durante Query;
- errores de red, almacenamiento y WebGPU;
- streaming, estadísticas, cancelación y errores del transporte WebLLM;
- ausencia de tráfico HTTP en las completions WebLLM;
- regresión de los proveedores HTTP existentes;
- separación de conversaciones y reutilización completa del motor entre turnos.

La validación final, en la rama `dev`, será:

1. `npm test`;
2. `npm run test:browser` por los cambios de interfaz;
3. `npm run build`;
4. comprobar que `zerochat.html` se ha regenerado;
5. una prueba manual de Query, descarga de un modelo e inferencia con un navegador que disponga de WebGPU.

## Referencias técnicas

- WebLLM documenta el catálogo en `prebuiltAppConfig.model_list` y el uso de `CreateMLCEngine`/`MLCEngine.reload()`.
- `initProgressCallback` informa de la inicialización y descarga del modelo.
- `hasModelInCache()` verifica los tensores del modelo, por lo que la interfaz deberá completar esa comprobación para comunicar una descarga totalmente disponible.
- WebLLM ofrece APIs de Web Worker para descargar y ejecutar la inferencia sin bloquear el hilo de interfaz.
- La caché predeterminada de WebLLM es Cache Storage; también admite IndexedDB, OPFS y almacenamiento cross-origin según la configuración elegida.
