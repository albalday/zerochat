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
- [x] M63-T6 Límites del historial sin borrado: medir con 2000 conversaciones el coste de conversations/list, de la sincronización completa a IndexedDB al conectar y del pintado de la barra; proponer en docs/ los topes o la carga diferida necesarios y abrir sus tareas tras decidir con el usuario (2026-11-13)
- [x] M63-T7 La barra no pinta las conversaciones de los grupos plegados; desplegar un grupo lo pinta (corrige M63-T4: 270 000 nodos ocultos con 10 000 conversaciones) (2026-11-13)
- [x] M63-T8 Tope de 50 conversaciones pintadas por grupo con botón "Mostrar N más"; la búsqueda sigue recorriendo todos los títulos (prueba en 50 y 51) (2026-11-13)
- [x] M63-T9 Borrar historial con un proyecto activo pregunta por las conversaciones de ese proyecto, con casilla para borrar todo; el servidor borra por proyecto y cancela solo las ejecuciones de esas conversaciones (2026-11-13)
- [x] M63-T10 Al conectar se sincronizan solo las cabeceras: la lista aparece en cuanto llega conversations/list y cada conversación se descarga a IndexedDB al abrirla; sin servidor, una no descargada avisa en vez de abrirse vacía (2026-11-13)
- [x] M63-T11 La clave del proxy de la conexión remota tiene el botón de ojo para mostrarla u ocultarla, con el mismo manejador que la API key del perfil (2026-11-13)
- [x] M63-T12 El historial deja de leer y escribir extra en el cliente y el servidor deja de exponerlo en la cabecera: profileId, serverRun y project ya viajan en ella (2026-11-13)
- [x] M63-T13 ConversationService sin guardas de opciones ni de serverRuns que solo pedían las pruebas, perfil de la sesión resuelto en un solo sitio y cabecera al abrir como fusión de la guardada y la leída (2026-11-13)
- [x] M63-T14 Borrar una conversación la quita de la barra solo si se borró del almacenamiento; switchToSession devuelve siempre un booleano (2026-11-13)
- [x] M63-T15 Storage sin hasBlob, con un único borrado local de conversaciones e hidratación de imágenes en un solo punto (2026-11-13)
- [x] M63-T16 Sin servidor, una conversación cuya cabecera remota es más reciente que su copia local abre esa copia en vez de avisar de que no está descargada (2026-11-13)
- [x] M63-T17 Upsert de sesiones compartido en ChatState, refresco de la lista tras una ejecución de servidor vía ConversationService y un único callback de repintado en la barra (2026-11-13)
- [x] M63-T18 Las herramientas reciben un contexto explícito (signal y, solo las de categoría agent, la conexión del agente) en vez de todos los parámetros del bucle (2026-11-13)
- [x] M63-T19 AgentRuntime sin campos, opciones ni callbacks sin consumidor: awaitingUser, reasoningText, totalTimeMs, onDone, appendFinalMessage, toolExecutions como contador y argumentos sin uso (2026-11-13)
- [x] M63-T20 AgentRuntime.execute dividido en paso de inferencia y cierre único; respuesta final y bucle detectado comparten rama (2026-11-13)
- [x] M63-T21 El aviso de bucle lo redacta ChatEngine con i18n; AgentRuntime solo informa del estado loop_detected (2026-11-13)
- [x] M63-T22 ToolExecutor parsea los argumentos una sola vez y separa el protocolo de autorización de la ejecución (2026-11-13)
- [x] M63-T23 Cada herramienta declara el texto de su evidencia visual; ChatEngine deja de listar nombres de herramientas (2026-11-13)
- [x] M63-T24 Auditoría completa de la 10.14.0: revisiones 1 a 4 de la ayuda escritas desde cero y una quinta con el nivel técnico y los consejos de evolución, en español e inglés (2026-11-13)
- [x] M63-T25 Incorporar a la auditoría los hallazgos comprobados de la revisión paralela con Gemini (F-12 a F-15, ayuda en F-06) y corregir help/remote-proxy.html, que describía la firma de herramientas retirada en M56 (2026-11-13)
- [x] M63-T26 Al rotar el token diario con el servidor en marcha se olvidan también las autorizaciones de sesión, bajo el mismo cerrojo; prueba con la fecha simulada: un permiso de sesión del día anterior vuelve a pedir confirmación (auditoría F-12) (2026-11-13)
- [x] M63-T27 Borrar conversaciones en SQLite elimina en la misma transacción los blobs que ninguna otra conversación referencia; prueba: se borra el de la única que lo usa y se conserva el compartido (auditoría F-05) (2026-11-13)
- [x] M63-T28 removeConversations confirma primero el borrado en el servidor y después borra la copia de IndexedDB y sus blobs sin referencias; prueba: un rechazo del servidor deja la conversación en el navegador (auditoría F-05, F-13) (2026-11-13)
- [x] M63-T29 Retirar las cabeceras CORS X-ZeroChat-Tool-* y la descripción de la firma HMAC de js/tools/README.md; prueba: las cabeceras permitidas son exactamente las que envía la interfaz (auditoría F-06) (2026-11-13)
- [x] M63-T30 test-runner falla si un archivo de grupo no existe, sin las referencias a test_mcp_status.js y test_browser_ui.js; test_ui_mcp.js compara SERVICE_STATUSES con tests/fixtures/mcp/contract.json (auditoría F-07) (2026-11-13)
- [x] M63-T31 Plazos del modo desatendido sin variables de entorno que solo usan las pruebas: decidir entre opción documentada de la CLI o parche de las constantes desde la prueba (auditoría F-08) (2026-11-13)
- [x] M63-T32 El sandbox del navegador restaura Function.prototype.constructor al resolverse la promesa del código, no en el finally síncrono; prueba: un escape por el constructor tras un await devuelve error (auditoría F-14) (2026-11-13)
- [x] M63-T33 validate_local_tool_arguments rechaza con error de validación un tipo de argumento que no conoce en lugar de lanzar TypeError; prueba con una definición de tipo no admitido (auditoría F-15) (2026-11-13)
- [x] M63-T34 Retirar del repositorio la copia de la verificación de Google en js/ y test-results/, añadirlos a .gitignore y decidir con el usuario si todo.txt sigue versionado (auditoría F-11) (2026-11-13)
- [x] M63-T35 Trabajos de CI en windows-latest y macos-latest para las pruebas Python de infraestructura y uno con el Node mínimo que fije M65 para test_run_node.js; cada fallo que aparezca se abre como tarea propia (auditoría F-09) (2026-11-13)

## M64 Modularización del backend Python

Goal: Reorganizar py/ en un paquete Python real con módulos cohesivos por capas y dominios (sin prefijos alfabéticos aa-..zz- ni dependencias circulares), manteniendo la compilación determinista en un único ejecutable zerochat.py para descarga directa y PyPI.
Done when: Todos los módulos en py/ son código Python válido e importable de forma aislada sin efectos secundarios en disco; no quedan archivos con prefijo aa-..zz- ni dependencias circulares ni duplicación de utilidades transversales; npm run build:backend genera zerochat.py mediante resolución topológica del grafo de dependencias AST; ruff y pyright (modo básico) pasan sobre py/ en la CI; py/README.md y los scripts de build/versión/higiene reflejan la nueva estructura; y toda la suite (§4) junto con tests/packaging_smoke_test.py pasan en verde.
- [ ] M64-T1 Compilador AST de py/ a zerochat.py conectado a npm run build:backend: un único espacio de nombres plano (las pruebas sustituyen símbolos de zerochat y hay instancias únicas compartidas), entre módulos propios solo `from paquete.modulo import nombre` (rechaza `import paquete.modulo`, acceso por atributo y alias), resolución topológica, detección de ciclos y colisiones de símbolos y deduplicación de imports stdlib; en transición emite primero los módulos del paquete y después los prefijados, y un módulo del paquete nunca importa uno prefijado; guarda el inventario de nombres de nivel superior del zerochat.py actual como fixture que cada tarea conserva salvo cambios declarados; con pruebas del compilador y soporte recursivo en test_backend_hygiene.js
- [ ] M64-T2 Capa base py/core/ (version.py, limits.py, logging.py, process.py unificando _kill_process_tree y _kill_pid_tree) y actualización de scripts/bump-version.mjs
- [ ] M64-T3 Migrar cc-environment.py a py/core/environment.py y ee-login.py más la gestión del token diario a py/auth/tokens.py y py/auth/login.py con imports explícitos
- [ ] M64-T4 Migrar ee-storage.py a py/storage/db.py usando py/core/limits.py, sin dependencias de herramientas ni efectos laterales al importar
- [ ] M64-T5 Dividir dd-security.py en py/security/context.py, py/security/rules.py (lógica pura) y py/security/controller.py (consumiendo storage.db sin ciclos)
- [ ] M64-T6 Dividir ee-browser-config.py y gg-browser.py en py/browser/launch.py, py/browser/config.py y py/browser/engines.py, rompiendo el ciclo con ee-mcp.py mediante callback de estado
- [ ] M64-T7 Migrar dd-managed-services.py y ee-mcp.py a py/mcp/ (managed_services.py, stdio_client.py, manager.py), actualizando scripts/build-managed-services.mjs y evitando materializar servicios al importar
- [ ] M64-T8 Extraer el transporte HTTP saliente y protección anti-SSRF de ff-server.py a py/web/fetch.py
- [ ] M64-T9 Migrar dd-commands.py a py/tools/jobs.py (sobre core.process y security.context) y dd-diff.py a py/tools/diff.py
- [ ] M64-T10 Dividir dd-tools.py en py/tools/filesystem.py, py/tools/browser_action.py y py/tools/registry.py, actualizando test_backend_hygiene.js
- [ ] M64-T11 Migrar ii-run-mode.py a py/run_mode/state.py y py/run_mode/supervisor.py eliminando la referencia circular con ff-server.py
- [ ] M64-T12 Dividir ff-server.py en py/server/state.py (BrowserLease, live_state, watchdog) y py/server/handler.py (despacho HTTP/JSON-RPC por grupos)
- [ ] M64-T13 Mover ConsoleControl a py/cli/console.py y migrar zz-main.py a py/cli/main.py con inicialización explícita del runtime manteniendo los símbolos públicos en zerochat.py
- [ ] M64-T14 Retirar el soporte de transición a prefijos aa-..zz-, verificar importación aislada sin side effects de py/, actualizar py/README.md y validar npm run test:all y tests/packaging_smoke_test.py
- [ ] M64-T15 Análisis estático en la CI sobre py/: ruff (nombres no definidos e imports sin uso) y pyright en modo básico, corrigiendo lo que detecten

## M65 Aislamiento de las ejecuciones en servidor

Goal: Que el código que corre con Node en las ejecuciones en servidor tenga el mismo nivel de contención que en el navegador: execute_javascript sin acceso al proceso ni al sistema y con plazo efectivo también en código asíncrono, y runner.js descargado y ejecutado con límites y sincronizado con js/ (auditoría 10.14.0, F-01 a F-04).
Done when: Ningún escape conocido por objetos heredados del anfitrión alcanza process desde execute_javascript en Node; un bucle asíncrono sin fin termina en su plazo; runner.js se lanza con permisos restringidos y su descarga tiene tope de tamaño y pruebas de sus cuatro ramas; una prueba falla si runner.js no coincide con el generado; la ayuda describe el aislamiento real en el servidor; y todos los niveles de §4 pasan en verde.
- [ ] M65-T1 Retirar execute_javascript del runner de Node hasta que esté aislado, con prueba de que una ejecución en servidor no la ofrece y aviso en tools-agent.html (cierra F-01 de inmediato)
- [ ] M65-T2 Decidir con el usuario el mecanismo de aislamiento en Node: modelo de permisos (exige subir el mínimo de Node, hoy 18) o proceso hijo con otra contención; registrar la decisión y el nuevo mínimo de Node
- [ ] M65-T3 execute_javascript en Node se ejecuta en un proceso hijo con el aislamiento decidido y se termina por señal al vencer el plazo; pruebas de escapes por objetos heredados y de bucle asíncrono en el plazo; vuelve al runner (F-01, F-02)
- [ ] M65-T4 runner.js se lanza con permisos restringidos (solo red) y su descarga tiene tope de tamaño; pruebas con un servidor local de descarga, 304, uso de la caché y fallo de red (F-03)
- [ ] M65-T5 Prueba en test_vendor_build.js que regenera runner.js en un directorio temporal y falla si no coincide con el versionado (F-04)

## M66 Coordinadores del frontend

Goal: Que js/app.js y js/mcp.js vuelvan a ser coordinadores: la sesión con el backend, el control de ejecución en servidor y el formateo de resultados MCP pasan a módulos propios sin cambiar el comportamiento (auditoría 10.14.0, F-10; la parte Python la cubre M64-T12).
Done when: app.js no contiene la conexión, identificación y guardado de la sesión del backend ni el estado de la ejecución en servidor; mcp.js no contiene el formateo de resultados e imágenes; los módulos nuevos siguen las normas de js/README.md y pasan las pruebas de arquitectura; y todos los niveles de §4 pasan en verde.
- [ ] M66-T1 Sesión con el backend (fragmento de arranque, destino configurado, clave del proxy, conexión, identificación y guardado) de app.js a un módulo de dominio propio
- [ ] M66-T2 Control de la ejecución en servidor (disponibilidad, estado vivo, ejecución activa y bloqueo del compositor) de app.js a un módulo propio
- [ ] M66-T3 Formateo de resultados de herramientas e imágenes MCP (formatToolCallResult, formatMcpMarkdown, imágenes seguras) de mcp.js a un módulo propio
