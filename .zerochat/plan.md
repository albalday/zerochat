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
- [ ] M61-T2 Reto ligado a una sola ejecución: sin challengeId en tools/call, authorize siempre ejecuta y consume, caducidad y cwd comprobados
- [ ] M61-T3 Identidad real del servidor en autorizaciones externas y sin confianza de servidor para herramientas locales
- [ ] M61-T4 allow_always de run_command solo con restricciones de comando y sin botón genérico en la tarjeta
- [ ] M61-T5 Reglas de directorio evaluadas sobre rutas reales (enlaces simbólicos) con el mismo resolutor que workspace_trust
- [ ] M61-T6 Actualización de políticas atómica, validada por entrada y con errores de persistencia visibles en la RPC
- [ ] M61-T7 AccessController sin caché del estado permanente: lectura por operación y escritura transaccional en SQLite
- [ ] M61-T8 tool_security de ejecuciones en servidor como capa de sesión en memoria, nunca persistida
- [ ] M61-T9 Regla de directorio del proyecto dinámica y nunca persistida (defaultDirectoryRule aparte de las reglas del usuario)
- [ ] M61-T10 zerochat/security/update como parche parcial (null revoca) en lugar de reemplazo completo
- [ ] M61-T11 ChatToolSecurity como caché del backend: sin localStorage, setters por parche y refresco tras conectar y cambiar de directorio
- [ ] M61-T12 Ajustes con la regla del proyecto de solo lectura, sin utilidades de rutas en JS, i18n y help sincronizados
- [ ] M61-T13 Limpieza del backend de permisos (constantes y helpers unificados, código muerto) y contrato documentado en los README
