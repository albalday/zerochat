# Plan

<!-- Hitos M1 a M51 archivados en .zerochat/archive/ -->

## M52 Robustez del transporte web en servidor: cabeceras de navegación y cadencia frente a retos anti-bot: closed 2026-11-08

## M53 Simplificación de la suite de pruebas, retirada de tests obsoletos y optimización de WebLLM: closed 2026-11-09

## M54 Mejoras al modo proyecto: normalización modal del panel de razonamiento y simplificación de memoria: closed 2026-11-09

## M55 Mejoras simples: closed 2026-11-10

## M56 Migración del control de acceso a MCPs y ejecuciones al backend y desacoplo para evolución multiusuario: closed 2026-11-10

## M57 Bucle agéntico desatendido en Node.js para --prompt y --conversation: closed 2026-11-10

## M58 Soporte de ejecución de JavaScript (execute_javascript) en Node.js desatendido

Goal: Adaptar la herramienta nativa execute_javascript y ChatSandbox para ejecutarse en Node.js mediante node:vm con aislamiento de contexto y control de timeout, integrándola en el runner headless (run-node.js / runner.js) para permitir al modelo resolver cálculos y transformaciones de datos en servidor.
Done when: ChatSandbox detecta el entorno Node y ejecuta código mediante node:vm sin depender del DOM ni iframes; las APIs de sistema (process, require, fs) quedan excluidas del sandbox; execute_javascript se activa en run-node.js; runner.js queda actualizado; y se añaden pruebas unitarias e integradas con toda la suite en verde.
- [x] M58-T1 Implementar ejecutor node:vm en js/sandbox.js con aislamiento y timeout para Node.js (2026-11-11)
- [x] M58-T2 Habilitar execute_javascript y ChatSandbox en js/run-node.js y compilar runner.js (2026-11-11)
- [x] M58-T3 Pruebas unitarias de sandbox en Node y de integración de execute_javascript en el runner (2026-11-11)
- [x] M58-T4 Actualización de documentación y verificación completa de la suite (2026-11-11)







