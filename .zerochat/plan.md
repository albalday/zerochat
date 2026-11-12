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

## M61 Integridad del sistema de permisos

Goal: Que el backend aplique los permisos sin atajos ni incoherencias: un reto equivale a una ejecución por un único punto, la identidad del servidor y el alcance de "permitir siempre" son correctos, SQLite es la única persistencia (atómica, sin caché ni capa en localStorage) y la regla del proyecto sigue al directorio actual. Especificación detallada en docs/audits/M61-permisos.md.
Done when: Los probes C1-C3, S1-S3 y D1 de docs/audits/M61-permisos.md se comportan como se espera y están cubiertos en test_security.py; el frontend no persiste permisos en localStorage; un solo punto ejecuta herramientas; la regla del proyecto es dinámica; no hay utilidades de rutas duplicadas entre JS y Python; y todos los niveles de §4 pasan en verde.
- [x] M61-T1 Punto único de ejecución de herramientas en ff-server (evaluar/retar/ejecutar/normalizar) con origen guardado en el reto (2026-11-11)
- [x] M61-T2 Reto ligado a una sola ejecución: sin challengeId en tools/call, authorize siempre ejecuta y consume, caducidad y cwd comprobados (2026-11-11)
- [x] M61-T3 Identidad real del servidor en autorizaciones externas y sin confianza de servidor para herramientas locales (2026-11-11)
- [x] M61-T4 allow_always de run_command solo con restricciones de comando y sin botón genérico en la tarjeta (2026-11-11)
- [x] M61-T5 Reglas de directorio evaluadas sobre rutas reales (enlaces simbólicos) con el mismo resolutor que workspace_trust (2026-11-11)
- [x] M61-T6 Actualización de políticas atómica, validada por entrada y con errores de persistencia visibles en la RPC (2026-11-11)
- [x] M61-T7 AccessController sin caché del estado permanente: lectura por operación y escritura transaccional en SQLite (2026-11-11)
- [x] M61-T8 tool_security de ejecuciones en servidor como capa de sesión en memoria, nunca persistida (2026-11-11)
- [x] M61-T9 Regla de directorio del proyecto dinámica y nunca persistida (defaultDirectoryRule aparte de las reglas del usuario) (2026-11-11)
- [x] M61-T10 zerochat/security/update como parche parcial (null revoca) en lugar de reemplazo completo (2026-11-11)
- [x] M61-T11 ChatToolSecurity como caché del backend: sin localStorage, setters por parche y refresco tras conectar y cambiar de directorio (2026-11-11)
- [x] M61-T12 Ajustes con la regla del proyecto de solo lectura, sin utilidades de rutas en JS, i18n y help sincronizados (2026-11-11)
- [x] M61-T13 Limpieza del backend de permisos (constantes y helpers unificados, código muerto) y contrato documentado en los README (2026-11-11)
- [x] M61-T14 Consolidar la limpieza pendiente: POLICIES único, validación de estado compartida, capa de sesión visible en export_state y formatToolCallResult común (2026-11-11)
- [x] M61-T15 Reto autorizado y consumido en una sola operación, decisión y regla de directorio en una transacción, errores visibles y grantedAt conservado en security/update (2026-11-11)
- [x] M61-T16 Errores de SQLite visibles, estado por defecto en una sola fuente y una lectura del estado permanente por evaluación (2026-11-11)
- [x] M61-T17 Retirar código solo de pruebas o sin consumidor en AccessController y ChatToolSecurity, y corregir las pruebas que dependían de él (2026-11-11)
- [x] M61-T18 Unificar normalización de ids, clasificación de herramientas de ficheros, parada de comandos en JS y caché del frontend sin decisiones propias (2026-11-11)
- [x] M61-T19 Prefijos de comando validados en el backend (lista no vacía, sin metacaracteres, tope), prefijo que cubre el comando del reto y oferta con subcomando (2026-11-11)
- [x] M61-T20 Prefijo editable en la tarjeta de autorización y prefijos editables en Ajustes › MCP (añadir/quitar, vacía revoca), i18n y ayuda (2026-11-11)
- [x] M61-T21 Campo del prefijo de comando en la tarjeta en su propia fila: el botón ya no lo deja sin ancho en el menú (2026-11-11)
- [x] M61-T22 Línea de comando editable con el * dentro ("git status *") y ✓ al lado para aceptarla; vacía, solo * o * intermedio desactivan ✓ (2026-11-11)
- [x] M61-T23 Prefijo de comando con tres alcances (esta sesión, este proyecto, todos los proyectos) en la tarjeta y agrupados por alcance en Ajustes (2026-11-11)
- [x] M61-T24 Comodín * en patrones de comando por argumento (shlex): * sin espacios ni /, " *" final para más argumentos, sin * texto exacto, .. rechazado; patrón compilado a regex (sin migración: se borra la base de datos) (2026-11-12)
- [x] M61-T25 Rediseño visual de los permisos en Ajustes › MCP: alcance de cada prefijo claro (global, proyecto, sesión), alta cuadrada y con alcance elegible, permisos de sesión visibles (2026-11-12)
- [x] M61-T26 Cambiar de proyecto (set_project_directory) borra las autorizaciones de sesión y los retos pendientes (2026-11-12)
- [x] M61-T27 Revisar y reestructurar las pruebas de permisos (Python, integración y navegador): quitar redundancias y casos obsoletos, probar solo el comportamiento vigente e importante (2026-11-12)
- [x] M61-T28 `cd dir ;` al inicio del comando tratado como `cd dir &&` al evaluar patrones (hoy solo se reconoce `&&` y `;` pide permiso como encadenamiento) (2026-11-12)
- [x] M61-T29 Renombrar prefijos a patrones en backend, frontend, i18n y pruebas (`allowedPrefixes`, `projectPrefixes`, `sessionPrefixes`, `matches_command_prefix`, `setCommandPrefixes`…); sin migración, preproducción (2026-11-12)
- [x] M61-T30 El * final de un patrón de comando exige a cada argumento extra lo mismo que el comodín (sin .., ~, $, llaves ni ruta absoluta) con un único predicado (2026-11-12)
- [x] M61-T31 run_command permanente sin patrones rechazado también en security/update (simétrico con allow_always) y sin "permitir" genérico en Ajustes (2026-11-12)
- [ ] M61-T32 Retirar opciones sin consumidor: allowChaining, allowPipes, deniedPatterns, alias de argumentos (cmd, script, file…), oferta de comando para herramientas que no son run_command y exportaciones JS sin uso
- [ ] M61-T33 Patrones de comando como sección propia del estado (commandPatterns: global, proyectos, sesión) en lugar de constraints de run_command; un patrón es una vía más de permitir y no anula workspace_trust
- [ ] M61-T34 evaluate_authorization partida en comando y ruta con el cd inicial analizado una vez, y SecurityContext obligatorio
- [ ] M61-T35 Validación de decisiones y tope de entradas en un solo sitio (authorize_challenge/record_decision, _validate_state_payload/_check_entry_limit)
- [ ] M61-T36 ToolSecurityManager simplificado: applyPolicies sin renormalizar lo del backend, sin helpers de indirección ni doble canal de aviso
- [ ] M61-T37 tools/call local y externo por un único _call_tool en ff-server
