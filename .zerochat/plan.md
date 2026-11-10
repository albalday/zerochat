# Plan

<!-- Hitos M1 a M51 archivados en .zerochat/archive/ -->

## M52 Robustez del transporte web en servidor: cabeceras de navegación y cadencia frente a retos anti-bot: closed 2026-11-08

## M53 Simplificación de la suite de pruebas, retirada de tests obsoletos y optimización de WebLLM: closed 2026-11-09

## M54 Mejoras al modo proyecto: normalización modal del panel de razonamiento y simplificación de memoria: closed 2026-11-09

## M55 Mejoras simples: closed 2026-11-10

## M56 Migración del control de acceso a MCPs y ejecuciones al backend y desacoplo para evolución multiusuario

Goal: Trasladar el motor de control de acceso y autorización de ejecuciones locales y herramientas MCP desde el frontend al backend, convirtiendo al servidor en el único punto de decisión y cumplimiento de políticas (PDP/PEP), eliminando la entrega de claves secretas HMAC al cliente y dejando en el frontend únicamente la interfaz de edición de permisos y la resolución de retos de autorización de usuario, estructurado sobre un contexto desacoplado (SecurityContext) extensible a multiusuario y multisesión.
Done when: El backend valida de forma autónoma llamadas a herramientas y comandos aplicando políticas globales, de herramienta, de servidor, listas R/W y restricciones de comandos; se retira TOOL_AUTH_KEY del handshake initialize; el frontend conserva la edición en ajustes y responde a retos de autorización; y pasan todas las suites de pruebas (unit, infrastructure, architecture, integration, browser).
- [x] M56-T1 Motor de seguridad y evaluación de políticas en backend con abstracción de contexto (SecurityContext y AccessController) (2026-11-10)
- [ ] M56-T2 Persistencia de políticas de seguridad en SQLite y endpoints RPC de gestión
- [ ] M56-T3 Interceptación de tools/call, retirada de TOOL_AUTH_KEY y protocolo de retos de autorización
- [ ] M56-T4 Refactorización de ChatToolSecurity y McpClient en frontend como adaptador cliente
- [ ] M56-T5 Adaptación de la interfaz de usuario: edición de permisos y respuesta a retos de autorización
- [ ] M56-T6 Modo de ejecución servidor/headless y validación de la suite de pruebas



