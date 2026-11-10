# Plan

<!-- Hitos M1 a M51 archivados en .zerochat/archive/ -->

## M52 Robustez del transporte web en servidor: cabeceras de navegación y cadencia frente a retos anti-bot: closed 2026-11-08

## M53 Simplificación de la suite de pruebas, retirada de tests obsoletos y optimización de WebLLM: closed 2026-11-09

## M54 Mejoras al modo proyecto: normalización modal del panel de razonamiento y simplificación de memoria: closed 2026-11-09

## M55 Mejoras simples: closed 2026-11-10

## M56 Migración del control de acceso a MCPs y ejecuciones al backend y desacoplo para evolución multiusuario: closed 2026-11-10

## M57 Bucle agéntico desatendido en Node.js para --prompt y --conversation

Goal: Sustituir el navegador Chromium de Playwright por un proceso ligero en Node.js para la ejecución desatendida (--prompt y --conversation), desacoplando el bucle agéntico del DOM mediante adaptadores de entorno que encapsulen las diferencias entre navegador y Node sin condicionales dispersos, acotando el alcance estrictamente a modelos remotos/APIs y herramientas del sistema/web (excluyendo RAG, WebGPU, render_chart y sandbox de navegador), y distribuyendo el runner desde GitHub Pages con caché local en ~/zerochat/cache/ para desacoplar completamente las actualizaciones de frontend de las versiones de PyPI.
Done when: --prompt y --conversation se ejecutan por defecto mediante Node.js (con --browser opcional para navegador visible); el runner se ejecuta localmente en desarrollo y se descarga/actualiza desde GitHub Pages con caché en producción; las diferencias de plataforma (almacenamiento, vistas, herramientas disponibles) quedan encapsuladas en adaptadores específicos sin bifurcaciones en el llamante; el paquete distribuido en PyPI (zerochat.py) pasa packaging_smoke_test.py; y toda la suite de pruebas (unit, integration, infrastructure, architecture, browser) pasa en verde.
- [x] M57-T1 Abstracción y encapsulación del entorno de ejecución (adaptadores de vista, persistencia y host sin DOM) (2026-11-10)
- [x] M57-T2 Punto de entrada y orquestador del runner en Node.js (js/run-node.js) (2026-11-10)
- [x] M57-T3 Empaquetado del runner standalone para distribución web (scripts/build-runner.mjs y runner.js) (2026-11-10)
- [x] M57-T4 Backend Python: detección de Node, descarga/caché de runner.js y supervisor de ejecución (py/ii-run-mode.py y py/zz-main.py) (2026-11-10)
- [x] M57-T5 Delimitación de herramientas y proveedores en Node: exclusión limpia de RAG, WebGPU, charts y sandbox iframe (2026-11-10)
- [x] M57-T6 Pruebas de infraestructura, integración y verificación de empaquetado (wheel y smoke test) (2026-11-10)
- [ ] M57-T7 Actualización de documentación (py/README.md y help/run-mode.html) y cierre






