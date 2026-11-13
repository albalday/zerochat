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

## M63 Cambios pequeños y pruebas: closed 2026-11-13

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

Goal: Que runner.js se descargue y se ejecute con límites y sincronizado con js/ (auditoría 10.14.0, F-03 y F-04); execute_javascript sigue en las ejecuciones en servidor con node:vm y su riesgo (F-01, F-02) queda pendiente de una contención real (decisiones M65-D1 y M65-D2).
Done when: runner.js se lanza con el modelo de permisos de Node y su descarga tiene tope de tamaño y pruebas de sus cuatro ramas; una prueba falla si runner.js no coincide con el generado; y todos los niveles de §4 pasan en verde.
- [x] M65-T1 Retirar execute_javascript del runner de Node (dropped: no se retira para volver a añadirlo enseguida; sigue en las ejecuciones en servidor, M65-D2)
- [x] M65-T2 Decidir con el usuario el mecanismo de aislamiento en Node: modelo de permisos (exige subir el mínimo de Node, hoy 18) o proceso hijo con otra contención; registrar la decisión y el nuevo mínimo de Node (2026-11-13)
- [x] M65-T3 execute_javascript en Node en un proceso hijo aislado (dropped: el modelo de permisos de Node no aísla código malicioso y no restringe la red hasta Node 25; la herramienta queda fuera del servidor, M65-D1)
- [ ] M65-T4 runner.js se lanza con el modelo de permisos de Node (--permission: sin escritura en disco, procesos, workers ni inspector) y su descarga tiene tope de tamaño; pruebas con un servidor local de descarga, 304, uso de la caché y fallo de red (F-03)
- [ ] M65-T5 Prueba en test_vendor_build.js que regenera runner.js en un directorio temporal y falla si no coincide con el versionado (F-04)

## M66 Coordinadores del frontend

Goal: Que js/app.js y js/mcp.js vuelvan a ser coordinadores: la sesión con el backend, el control de ejecución en servidor y el formateo de resultados MCP pasan a módulos propios sin cambiar el comportamiento (auditoría 10.14.0, F-10; la parte Python la cubre M64-T12).
Done when: app.js no contiene la conexión, identificación y guardado de la sesión del backend ni el estado de la ejecución en servidor; mcp.js no contiene el formateo de resultados e imágenes; los módulos nuevos siguen las normas de js/README.md y pasan las pruebas de arquitectura; y todos los niveles de §4 pasan en verde.
- [ ] M66-T1 Sesión con el backend (fragmento de arranque, destino configurado, clave del proxy, conexión, identificación y guardado) de app.js a un módulo de dominio propio
- [ ] M66-T2 Control de la ejecución en servidor (disponibilidad, estado vivo, ejecución activa y bloqueo del compositor) de app.js a un módulo propio
- [ ] M66-T3 Formateo de resultados de herramientas e imágenes MCP (formatToolCallResult, formatMcpMarkdown, imágenes seguras) de mcp.js a un módulo propio
