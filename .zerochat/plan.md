# Plan

<!-- Hitos M1 a M77 archivados en .zerochat/archive/ -->

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora: closed 2026-11-20

## M80 Entorno de ejecución por proyecto: closed 2026-11-20

## M81 Propuestas de mejora: closed 2026-11-21

## M83 Esperas síncronas en lugar de sondeo (restos tras M81): closed 2026-11-21

## M84 ZeroChat como ejecutor para orquestadores de agentes: closed 2026-11-21

## M85 Secretos por proyecto y relleno seguro en navegador: closed 2026-11-22

## M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20: closed 2026-11-22

## M86 Mejoras para proyectos de agentes y `--run-file`: closed 2026-11-23

## M87 Mejoras sistema de agentes: closed 2026-11-24

## M88 Ajustes de control de agentes: closed 2026-11-25

## M89 Adaptación del bucle agéntico al contexto del modelo: closed 2026-11-25

## M90 Reorganización del panel MCP: closed 2026-11-25

## M91 Adjuntos en el MCP de correo: closed 2026-11-25

## M92 Acciones durante un turno en marcha: closed 2026-11-25

## M93 Correcciones del navegador de agentes

Goal: que las ejecuciones desatendidas no contaminen el User-Agent real guardado del navegador.
Done when: el runner de Node no fija ni persiste su User-Agent, con todos los niveles de §4 en verde.
- [x] M93-T1 Capturar el User-Agent del frontend solo tras autenticar y nunca con el token del runner (py/server/handler.py), con prueba (2026-11-25)
- [x] M93-T2 Aclarar en la interfaz que Chrome, Edge y Chromium del sistema en modo propio usan un perfil vacío sin las cookies del usuario (js/i18n.js) (2026-11-25)

