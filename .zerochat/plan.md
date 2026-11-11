# Plan

<!-- Hitos M1 a M51 archivados en .zerochat/archive/ -->

## M52 Robustez del transporte web en servidor: cabeceras de navegación y cadencia frente a retos anti-bot: closed 2026-11-08

## M53 Simplificación de la suite de pruebas, retirada de tests obsoletos y optimización de WebLLM: closed 2026-11-09

## M54 Mejoras al modo proyecto: normalización modal del panel de razonamiento y simplificación de memoria: closed 2026-11-09

## M55 Mejoras simples: closed 2026-11-10

## M56 Migración del control de acceso a MCPs y ejecuciones al backend y desacoplo para evolución multiusuario: closed 2026-11-10

## M57 Bucle agéntico desatendido en Node.js para --prompt y --conversation: closed 2026-11-10

## M58 Soporte de ejecución de JavaScript (execute_javascript) en Node.js desatendido: closed 2026-11-11

## M59 Habilitar render_chart en Node.js desatendido para visualización en cliente

Goal: Activar la herramienta nativa render_chart en el runner headless de Node.js (run-node.js y runner.js) registrando las llamadas y datos en el historial sin requerir DOM, permitiendo al cliente web renderizar el gráfico interactivo al abrir el chat.
Done when: ChatBuiltinRenderChartTool se carga en js/run-node.js y se retira de disabledTools; runner.js queda actualizado; se prueban en tests unitarios y de integración; y toda la suite pasa en verde.
- [x] M59-T1 Habilitar render_chart en js/run-node.js y recompilar runner.js (2026-11-11)
- [x] M59-T2 Pruebas unitarias y de integración de render_chart en Node y verificación de la suite (2026-11-11)







