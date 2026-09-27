# Auditoría técnica de ZeroChat

Fecha: 27 de septiembre de 2026. Versión examinada: **7.12.0**, backend compatible **7.12**. Rama: `dev`. Commit de referencia: `b0d55a7d3094178ca0a5f9afe24747ae283102b3`.

Estado: informe cerrado; los hallazgos quedan abiertos. Esta auditoría no modifica ni corrige el producto. El cambio preexistente en `todo.txt` queda fuera del análisis.

Informes relacionados: [adecuación funcional](2026-09-27-02-auditoria-funcional.md) y [comparativa competitiva](2026-09-27-03-comparativa-competencia.md).

## 1. Dictamen

**ZeroChat presenta una base técnica sólida para una herramienta personal supervisada, con reservas relevantes de seguridad y recuperación ante errores.** La separación de proveedores, estado, persistencia, herramientas e interfaz es real y está respaldada por pruebas. La suite completa pasa. Sin embargo, comprobaciones adicionales reproducen una elusión de la lista de archivos públicos del servidor de desarrollo, permisos demasiado abiertos del token bajo una configuración habitual y un interbloqueo del controlador del navegador.

No se justifica una reescritura ni introducir infraestructura empresarial. Sí se recomienda corregir estos defectos y revisar el modelo de protección de credenciales antes de ampliar el alcance de las herramientas o presentar el producto como un entorno seguro para información sensible.

El resultado no equivale a una certificación, una medición de cobertura de código ni una garantía de ausencia de vulnerabilidades. Es una revisión transversal del código y documentación, ejecución de la suite y comprobaciones dirigidas sobre puntos de mayor riesgo.

## 2. Alcance y método

Se revisaron `zerochat.html`, los módulos principales de `js/`, los ocho módulos de `py/`, la correspondencia con `zerochat.py`, el service worker, la configuración de distribución, los workflows, el runner, pruebas representativas de cada nivel y las guías de usuario. Se examinaron especialmente autenticación local, autorización de herramientas, credenciales, ejecución de procesos, almacenamiento, RAG, proveedores y recuperación de errores.

Entorno de ejecución: Linux, Node **24.18.1**, Python **3.14.7**, Chromium mediante Playwright. La CI declara Node 22 y Python 3.12 sobre Ubuntu; no es exactamente el mismo entorno.

Tipos de evidencia:

- **R: reproducido** mediante ejecución de la suite o una comprobación adicional controlada.
- **C: comprobado en código/configuración**; no supone explotación ni fallo observado en producción.
- **P: pendiente de medición**; recomendación de validación, no defecto demostrado.

Prioridades: **P1** corregir antes de ampliar exposición o capacidades; **P2** siguiente bloque de consolidación; **P3** mejora incremental. La severidad expresa impacto potencial; la prioridad incorpora el uso personal previsto. No se asignan puntuaciones CVSS sin un análisis específico de despliegue y amenaza.

No se hicieron llamadas de pago a proveedores, un pentest externo, pruebas de carga destructivas, una evaluación de accesibilidad con usuarios, inferencia real con GPU ni instalación en Windows/macOS. Tampoco se construyó un wheel en esta revisión. No se han inspeccionado credenciales reales.

## 3. Evidencia ejecutada

| Comprobación | Resultado | Alcance |
|---|---|---|
| `npm test` | **666 pruebas, 666 correctas, 0 fallos, 0 omitidas**, salida 0 | Todos los niveles descubiertos por el runner |
| Inventario del runner | 90 archivos: 37 unitarios, 33 integración, 14 navegador, 3 arquitectura y 3 infraestructura | Cuenta de archivos, distinta de la cuenta de casos |
| Comparación binaria de concatenación ordenada de `py/*.py` con `zerochat.py` | Coinciden | Backend generado sincronizado |
| `npm audit --json` | 0 vulnerabilidades notificadas | Dependencias npm auditadas; no cubre código propio, CDN ni todos los MCP instalables |
| HTTP local sin token a `/js/../package.json` | **200**, cuerpo igual a `package.json` | Servidor efímero de auditoría, cliente HTTP que conserva `..` |
| Creación del token con `umask 022` | Archivo **0644**, token reutilizado | Directorio temporal mediante `ZEROCHAT_DATA_DIR`; no se imprime el token |
| Cifrado/descifrado de valor ficticio con clave predeterminada | Recuperable sin contraseña | API pública de `profile-backup.js` |
| EOF inmediato en proceso simulado de `PersistentBrowserSession` | Hilo bloqueado, mutex retenido | Reproducción aislada de la clase; sin lanzar navegador |
| Integridad de grupos de pruebas | Una ruta inexistente en `generation` | La suite completa sí encuentra el archivo real |

Los tests de arranque incluyen comprobaciones de consola y pasaron. El log general contiene errores provocados deliberadamente por pruebas negativas, por ejemplo de WebLLM; no deben confundirse con errores de consola de un arranque normal. No se ha medido cobertura de líneas o ramas: 666 pruebas no permiten inferir un porcentaje.

## 4. Calidad por área

| Área | Evaluación | Evidencia y límite |
|---|---|---|
| Arquitectura | Buena base modular | UMD, `BaseProviderAdapter`, `ChatState`, `ChatConfig`, servicios de conversación y contratos de herramientas |
| Mantenibilidad | Correcta, con concentración de complejidad | `app.js`: 2.158 líneas; `file-parser.js`: 2.088; `agent-core.js`: 1.670; tamaño no equivale por sí solo a defecto |
| Fiabilidad | Amplia regresión automatizada, recuperación incompleta | Suite verde, pero interbloqueo reproducido fuera de los casos cubiertos |
| Seguridad | Controles reales y brechas concretas | Token, HMAC, nonces, validación y aislamiento JS; reservas detalladas debajo |
| Persistencia | Diseño adecuado al uso individual | IndexedDB, almacenes separados de adjuntos y RAG; exportaciones y tratamiento de cuotas |
| Rendimiento | Decisiones razonables, sin capacidad certificada | Índice en memoria, límites de ingesta y sandbox, actualización diferida de paneles; faltan benchmarks |
| Compatibilidad | Contratos comprobados, matriz real limitada | Adaptadores y pruebas; navegador de CI limitado a Chromium |
| Distribución | Clara y automatizada | Concatenación sincronizada, wheel configurado con un único módulo, release con Trusted Publishing |
| Documentación | Extensa, con promesas excesivas | Ayuda bilingüe; privacidad y significado de cifrado necesitan precisión |

### Fortalezas que conviene conservar

1. Los [adaptadores](../../js/providers.js) normalizan formatos y streaming sin dispersar toda la integración en la interfaz. El modo Espejo permite observar peticiones sin proveedor.
2. [Estado](../../js/state.js), [configuración](../../js/config-store.js) y [servicio de conversación](../../js/conversation-service.js) tienen límites explícitos y pruebas de coordinación.
3. [ZeroChatDB](../../js/storage-db.js) centraliza el esquema y separa mensajes, adjuntos y conocimiento. [RagStorage](../../js/ragStorage.js) contempla persistencia, estimación de cuota y exportación/importación.
4. El [contrato de herramientas](../../js/tools/README.md) identifica ejecución, serialización, presentación y dependencias. El ejecutor incorpora autorización antes de ejecutar.
5. El [servidor](../../py/ff-server.py) exige token para la API, compara secretos con `compare_digest`, limita el cuerpo HTTP a 1 MiB y verifica firmas con caducidad, hash del cuerpo y nonce consumido atómicamente. La firma no debe confundirse con aislamiento frente a un frontend comprometido.
6. El [sandbox JavaScript](../../js/sandbox.js) tiene iframe, worker, restricciones de red y terminación temporal, con pruebas de navegador. Su propio contrato aclara que no es aislamiento de sistema operativo.
7. La CI ejecuta los cinco niveles, y la publicación valida etiqueta, paquete y pruebas antes de Trusted Publishing. No se requiere incorporar un sistema de compilación web para obtener estas garantías.

## 5. Hallazgos y acciones

### T01. Elusión de la lista de archivos estáticos — media, P1, R

**Evidencia:** `ZeroChatServerHandler.serve_static_file`, [ff-server.py](../../py/ff-server.py). Se verifica que la ruta resuelta permanezca dentro del repositorio, pero la lista permitida se evalúa sobre `clean_rel`, anterior a resolver `..`. `/js/../package.json` empieza por `js/` y termina leyendo un archivo no autorizado de la raíz.

**Reproducción:** servidor local temporal y `http.client.HTTPConnection`; GET literal a `/js/../package.json`, sin Authorization ni Origin. Resultado: 200 y contenido idéntico al archivo. Un navegador o `fetch` puede normalizar el camino antes del envío; el caso existente con `/../package.json` no cubre este vector.

**Impacto:** lectura sin token de archivos no ocultos y no bloqueados dentro del repositorio de desarrollo. No se ha demostrado escape fuera de esa raíz, acceso a archivos ocultos ni ejecución de código. El modo instalado sin raíz de desarrollo no sirve estos archivos. La escucha loopback limita la exposición por defecto.

**Acción y aceptación:** aplicar la lista permitida a la ruta canónica relativa y revisar enlaces simbólicos. Añadir solicitudes HTTP sin normalización con `..`, rutas válidas, archivos ocultos y symlinks. Todos los destinos no autorizados deben rechazarse, aunque la entrada empiece por `js/`.

### T02. Token diario con permisos dependientes de umask — alta condicionada al acceso local, P1, R/C

**Evidencia:** `get_daily_token`, [cc-environment.py](../../py/cc-environment.py), escribe `config/token.tmp` y lo renombra, sin fijar permisos. Con `umask 022`, el resultado reproducido es **0644**. Se reutiliza durante el día; las pruebas existentes lo exigen expresamente. No es un secreto nuevo para cada arranque.

**Impacto:** otro usuario local podría leerlo si también puede atravesar los directorios padres. No se presupone que todos los hogares sean accesibles. Con el token, un cliente puede inicializar la API y obtener credenciales de firma; el HMAC no protege frente al robo de ese token. La clave HMAC sí cambia en cada arranque.

**Acción y aceptación:** crear el secreto con permisos exclusivos, proteger el directorio y definir ACL apropiadas en Windows. Corregir permisos de archivos existentes. Decidir y documentar si la comodidad del token diario se conserva; no basta con llamarlo efímero. Tests con umask permisiva, token existente y reinicio deben comprobar permisos y ciclo de vida sin registrar secretos.

### T03. Protección limitada de credenciales y copias — alta con acceso al almacenamiento/exportación, P1, R/C

**Evidencia:** [profile-backup.js](../../js/profile-backup.js), `getKey`, `keyMaterialFromPassword`, `cacheKeyMaterial`. El modo predeterminado deriva la clave AES-GCM de una constante incluida en el código. La contraseña personalizada se transforma mediante SHA-256 sin sal ni factor de trabajo; el material derivado puede recordarse en localStorage durante 24 horas.

**Impacto:** AES-GCM aporta integridad criptográfica, pero una clave pública no aporta confidencialidad frente a quien obtiene una copia cifrada. Una contraseña débil permite intentos offline rápidos. El material recordado permite descifrar mientras sea accesible; tampoco protege frente a JavaScript malicioso del mismo origen. La limitación de la clave embebida está reconocida en el comentario del módulo, pero debe ser inequívoca en la experiencia del usuario.

**Acción y aceptación:** diferenciar explícitamente protección predeterminada y cifrado con contraseña; para confidencialidad, utilizar derivación con sal y coste configurable, formato versionado y migración. Evitar persistir material equivalente a la clave sin una elección informada. Probar restauración antigua/nueva, contraseña incorrecta, manipulación y eliminación de la clave recordada. No recomendar un cambio que inutilice las copias existentes.

### T04. Interbloqueo al fallar el navegador automatizado — media, P1, R

**Evidencia:** `PersistentBrowserSession.execute` y `close`, [dd-tools.py](../../py/dd-tools.py). `execute` mantiene un `threading.Lock` y llama a `close` ante EOF o excepción; `close` intenta adquirir el mismo lock, que no es reentrante.

**Reproducción:** clase original extraída con AST, `_ensure_running` sustituido por un proceso simulado con stdin de memoria y stdout vacío. Tras EOF inmediato, `execute` no termina y el lock continúa retenido. Se ejecutó en un hilo daemon aislado, sin navegador ni procesos pendientes.

**Impacto:** una caída del proceso puede dejar bloqueadas llamadas posteriores y el cierre de esa sesión. Además, `readline()` no tiene un límite propio de espera; los timeouts de Playwright no cubren todos los fallos del proceso.

**Acción y aceptación:** separar limpieza interna bajo lock de cierre público o revisar la estrategia de bloqueo, e incorporar un deadline de IPC. Probar EOF, JSON inválido, tubería rota, proceso silencioso, cierre concurrente y posterior recuperación.

### T05. Posible ejecución de MCP Python fuera del venv — media, P2, C

**Evidencia:** `_prepare_service`, [ee-mcp.py](../../py/ee-mcp.py), usa `sys.executable` como `pythonExecutable` si no existe el Python del venv. [cc-environment.py](../../py/cc-environment.py) permite continuar cuando falla su creación.

**Impacto:** contradice la norma de ejecutar MCP Python exclusivamente en `~/zerochat/.venv`. No se ha demostrado instalación global de paquetes; el hallazgo es la ruta de ejecución alternativa.

**Acción y aceptación:** mantener operativo el chat, pero declarar indisponible el MCP afectado si falta su intérprete aislado. Probar ausencia/fallo del venv y verificar que no se lanza el Python global como alternativa.

### T06. Privacidad descrita de forma más amplia que la implementación — media, P1, C

**Evidencia:** [README](../../README.md) promete privacidad absoluta y ausencia de intermediarios; [ayuda RAG](../../help/rag.html) afirma que los datos jamás abandonan el equipo, aunque indica después que envía fragmentos al modelo. [web-search.js](../../js/web-search.js) utiliza Jina para buscar, y [web-browser.js](../../js/web-browser.js) incluye Jina y AllOrigins. El índice RAG sí se construye localmente.

**Impacto:** el usuario puede introducir información sensible bajo una expectativa equivocada. El tercero puede recibir consultas o URLs; si los resultados RAG se envían a un proveedor remoto, esos fragmentos salen del dispositivo. No implica que todas las conversaciones pasen por un proxy.

**Acción y aceptación:** explicar destinos por función y añadir una opción explícita para impedir intermediarios. Corregir ambas lenguas. Una prueba con solicitudes interceptadas debe demostrar que el modo sin intermediarios no contacta con esos dominios.

### T07. Límites de ejecución parcial y aislamiento compartido — media, P2, C/P

**Evidencia:** [dd-tools.py](../../py/dd-tools.py) conserva `BASH_SESSION` y `_BROWSER_SESSION` por proceso, sin partición por conversación. El shell conserva cwd y variables exportadas. `communicate()`/`capture_output=True` acumulan salida antes de truncarla. La rama de ejecución con cwd distinto utiliza `subprocess.run(shell=True)`; la rama persistente sí mata el grupo de procesos al agotar tiempo.

**Impacto:** dos conversaciones que usan el mismo backend comparten contexto del sistema. Truncar la respuesta no limita la memoria necesaria para capturarla. Cancelar la solicitud del frontend no acredita por sí solo la terminación del trabajo remoto. No se han provocado agotamientos de memoria ni medido procesos huérfanos.

**Acción y aceptación:** decidir si la sesión compartida es una función y hacerla visible; ofrecer reinicio por proyecto o aislarla cuando proceda. Acotar salida durante lectura, homogeneizar terminación de árboles y comprobar cancelación con procesos ficticios. Una segunda conversación debe tener comportamiento documentado respecto a cwd, entorno y navegador.

### T08. Selección parcial de pruebas incompleta — media, P2, R/C

**Evidencia:** [test-runner.mjs](../../scripts/test-runner.mjs). `generation` referencia `tests/unit/test_generation_controller.js`, pero existe en `tests/integration/`. `resolveGroupFiles` filtra silenciosamente rutas ausentes. `resolveChangedFiles` asigna genéricamente solo unitarias a cambios como `js/chat-engine.js`, `js/state.js` o `js/rag-service.js`, pese a sus pruebas de integración.

**Impacto:** un grupo o `test:changed` puede dar verde sin ejecutar regresiones relevantes. **No afecta al resultado de `npm test` ni a la CI completa**, que descubren todos los niveles.

**Acción y aceptación:** corregir el grupo, rechazar entradas inexistentes y cubrir con tests el mapa de impacto de los módulos principales. Comprobar listados de grupos y selección por archivo modificado.

### T09. Actualización web sin garantía de conjunto atómico — media, P2, C/P

**Evidencia:** [sw.js](../../sw.js) usa precarga con `Promise.allSettled`, tolera fallos, activa mediante `skipWaiting` y actualiza recursos individualmente con stale-while-revalidate.

**Impacto potencial:** una actualización parcial o conectividad intermitente puede dejar una combinación de recursos o una caché incompleta. No se ha reproducido aquí una rotura de actualización.

**Acción y aceptación:** comprobar instalación completa antes de activar o verificar un manifiesto de recursos coherente. Ensayar transición entre dos versiones, un recurso que falla, dos pestañas y arranque offline. Distinguir caché web de disponibilidad de modelos WebLLM.

### T10. Cobertura de plataformas, rendimiento y resultados externos — media, P2, C/P

**Evidencia:** los [helpers de navegador](../../tests/helpers/browser-env.js) usan Chromium; los workflows se ejecutan en Ubuntu. Las pruebas de adaptadores y WebLLM no acreditan funcionamiento real de todos los modelos ni de toda GPU. No se obtuvo un benchmark de corpus, concurrencia o latencias.

**Acción y aceptación:** definir una matriz mínima soportada; probar instalación en plataformas anunciadas, Safari/Firefox si se mantienen dentro del soporte, proveedores con un conjunto pequeño y controlado, cuotas y recuperación de almacenamiento. Registrar hardware, datos y percentiles. No declarar un límite de corpus basándose solo en que cada documento admita 50 MiB.

### T11. Superficie de confianza del frontend y dependencias dinámicas — media, P2, C

**Evidencia:** CSP de [zerochat.html](../../zerochat.html) permite `unsafe-inline`, `unsafe-eval` y conexiones amplias; [providers-webllm.js](../../js/providers-webllm.js) importa código desde CDN. La cookie de sesión se escribe desde JS con `Path=/` en [cookies.js](../../js/cookies.js). GitHub Pages comparte origen entre rutas del mismo dominio; una ruta no es una frontera de seguridad.

**Impacto:** un compromiso del origen o código que ejecuta la aplicación puede alcanzar datos y secretos disponibles al cliente. No se ha encontrado ni explotado aquí una vulnerabilidad XSS; estas son fronteras de confianza, no una prueba de compromiso. `npm audit` no las descarta.

**Acción y aceptación:** inventariar dependencias cargadas en ejecución, justificar excepciones CSP y probar reducciones graduales. Considerar origen dedicado si se alojan aplicaciones de distinta confianza. Documentar que las firmas de herramientas no defienden frente al propio frontend comprometido.

### T12. Concentración de responsabilidades y deuda documental — baja, P3, C

**Evidencia:** módulos de más de 1.500–2.000 líneas, parser de documentos propio y orden manual de scripts. El README habla de un único HTML aunque la web requiere `js/` y `css/`. La metadescripción de la ayuda RAG menciona búsqueda híbrida, pero [rag-index.js](../../js/rag-index.js) construye campos textuales y consulta lexical con tolerancia y pesos, sin embeddings en ese flujo.

**Acción y aceptación:** corregir términos, documentar límites del parser y extraer responsabilidades solo al modificar áreas concretas. Mantener contratos y regresiones; no sustituir la arquitectura por tamaño de archivo solamente.

## 6. Plan de consolidación

| Orden | Trabajo | Criterio de cierre |
|---|---|---|
| 1 | T01, T02, T04 | Reproducciones convertidas en regresiones que pasan tras corregir el defecto |
| 2 | T03 y T06 | Protección y destinos de datos inequívocos, migración de copias validada, ayuda ES/EN coherente |
| 3 | T05, T07 y T08 | Venv obligatorio para MCP Python, cancelación/estado explícitos y selección de tests fiable |
| 4 | T09–T11 | Pruebas de actualización, matriz soportada y fronteras de confianza documentadas |
| Continuo | T12 | Cambios pequeños acompañados de contratos y pruebas, sin refactorización general |

No se solicita promoción a `master`, incremento de versión ni publicación. Cuando se implementen correcciones, deben respetar el flujo de `dev` y la validación aplicable.

## 7. Repetición de la revisión

Comandos principales ejecutados:

```bash
npm test
npm audit --json
node scripts/test-runner.mjs --list
```

Para el vector HTTP, iniciar un backend de prueba con `ZEROCHAT_DATA_DIR` apuntando a un directorio temporal, escucha loopback, sin navegador ni venv. Enviar con `http.client` la ruta literal `/js/../package.json`; alternativamente usar `curl --path-as-is`. Comparar estado y contenido, sin introducir datos sensibles. Cerrar el proceso al terminar. Para permisos, establecer `umask 022`, llamar a `get_daily_token` en ese entorno temporal y consultar `stat`, sin mostrar el valor.

Para el interbloqueo, simular stdout cerrado y ejecutar `execute` en un proceso/hilo controlado con deadline; la comprobación no debe quedar esperando indefinidamente al reproducir el defecto. Para cifrado, usar exclusivamente un valor ficticio y verificar descifrado mediante el modo predeterminado sin contraseña.

Los resultados adicionales no alteran la suite del producto: explican precisamente los huecos que una futura corrección debe cubrir. Los informes anteriores del repositorio son históricos y no se utilizaron como prueba de que un defecto continúe existiendo.
