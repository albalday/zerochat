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

## M86 Mejoras para proyectos de agentes y `--run-file`

Goal: pulir la ejecución desatendida con `--run-file` y las plantillas de proyectos de agentes a partir de la experiencia práctica con agentes reales.
Done when: las mejoras acordadas en M86 están implementadas con todos los niveles de §4 en verde.
- [ ] M86-T1 Controlar en `--run-file` la inyección de normas en sistema del proyecto (`projectMode` booleano opcional en `RUN_FILE_KEYS` / runner, o desactivado por defecto cuando el agente define su propio manual operativo): decidir y aplicar si `--run-file` inyecta o excluye `AGENTS.md` y `.zerochat/state.md`, actualizando `templates/project/mode-agent.txt` y `mode-agent-templates.txt`
- [x] M86-T2 Persistir el último User-Agent real del navegador en SQLite y añadir en Ajustes › Navegador y py/browser/config.py modo automático/rotativo por sesión o personalizado (actualizando DEFAULT_USER_AGENT) (2026-11-22)
- [x] M86-T3 Permitir canal chrome/navegador del sistema en modo propio headless (--browser=chrome --headless --isolated) en py/browser/config.py y Ajustes › Navegador para ejecuciones desatendidas sin sesión gráfica (2026-11-22)
