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
2. Buscar el JavaScript de una versión de WebLLM fijada en la caché propia.
3. Si falta, descargarlo de forma progresiva, sin usar una versión `latest`.
4. Verificar la integridad fijada antes de almacenarlo y ejecutarlo.
5. Cargar el módulo y obtener su configuración precompilada.
6. Consultar el catálogo de modelos y el estado local de cada uno.

El estado del editor informará de forma breve:

```text
Descargando WebLLM… 4,2 MB
Preparando WebLLM…
WebLLM preparado. Modelos disponibles: …
```

Cuando el servidor informe una longitud fiable, se mostrará porcentaje; de lo contrario, se mostrarán bytes descargados o un indicador indeterminado. La caché del JavaScript será separada de la caché de artefactos de modelos que administra WebLLM.

La implementación fijará versión, URL e integridad. Se validará que el formato de distribución elegido puede cargarse en navegador desde el bundle de ZeroChat y que las dependencias del módulo conservan URLs resolubles tras la carga.

## Catálogo y estado de modelos

La fuente del catálogo será `webllm.prebuiltAppConfig.model_list` de la misma versión de WebLLM cargada. No se mantendrá una lista manual ni se consultará `/v1/models`.

Cada modelo se convertirá al formato consumido por el selector existente, manteniendo su identificador exacto. El editor presentará, además del selector, una lista compacta:

| Modelo | Estado local | Acción |
| --- | --- | --- |
| Identificador del modelo | No descargado | Descargar |
| Identificador del modelo | Descargado | — |
| Identificador del modelo | Descargando, 46 % | Cancelar |

Cuando los metadatos lo publiquen, podrá mostrarse el requisito estimado de VRAM. Esa cifra no se presentará como tamaño de descarga ni como garantía de memoria disponible.

Para conocer el estado inicial se usará `hasModelInCache(modelId, appConfig)`. Puesto que esa función verifica los tensores y no todos los artefactos necesarios, el estado completo deberá validar también configuración, tokenizer y WASM para la versión fijada. Si no se puede asegurar el resultado se presentará como «Incompleto» o «No comprobado», no como descargado.

La lista se volverá a comprobar en cada Query; no se persistirá un booleano de descarga dentro del perfil.

## Descargar modelos

El botón Descargar usará el flujo oficial:

```js
await engine.reload(modelId);
```

`initProgressCallback` actualizará el estado y la barra de progreso. Como esta operación descarga y prepara recursos, el texto será «Descargando y preparando…», sin atribuir todo el tiempo a la transferencia.

El motor se ejecutará en un Web Worker privado del adaptador para no bloquear la interfaz. El worker será un detalle interno del proveedor.

Reglas de operación:

- una descarga activa por editor de perfiles;
- cancelar termina el worker de esa operación y vuelve a comprobar la caché;
- una descarga interrumpida no se mostrará como completa;
- al terminar se libera el motor de GPU, pero los archivos permanecen cacheados;
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

El estado compartido que sea necesario deberá usar los slices y mutadores existentes de `ChatState`. No se introducirán variables globales de módulo con historial de conversación.

La primera versión usará un motor por petición y lo liberará al finalizar. Esto evita historial oculto entre conversaciones y cambios en el sistema de sesiones. La preparación del modelo en GPU puede repetirse, aunque sus archivos ya estarán cacheados.

Antes de considerar compatible el proveedor se probará desde el modo habitual de la aplicación y, si el proyecto lo soporta, desde `file://`. WebGPU, caché y workers se comprobarán en navegador real. Cuando falte una capacidad, el perfil explicará el motivo concreto.

## Pruebas y aceptación

Se añadirán o ajustarán pruebas para:

- carga diferida y reutilización de la caché del JavaScript;
- catálogo de modelos y estado descargado, incompleto o desconocido;
- progreso, cancelación y reintento de descarga;
- cambio de perfil durante Query;
- errores de red, almacenamiento y WebGPU;
- streaming, estadísticas, cancelación y errores del transporte WebLLM;
- ausencia de tráfico HTTP en las completions WebLLM;
- regresión de los proveedores HTTP existentes;
- separación de conversaciones.

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

