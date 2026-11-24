# Current state
- Milestone: M88 Ajustes de control de agentes
- Next task: M88-T5 Nivel de razonamiento en --run-file (reasoning: none, low, medium, high, xhigh; medium por defecto): validar reasoning en parse_run_request (py/run_mode/state.py) con medium por defecto cuando no se indique en --run-file, guardarlo en launch (RUN_LAUNCH_KEYS) para conservarlo al reanudar needs_input o continuar con --conversation, entregarlo en zerochat/run/prompt y aplicarlo en js/run-mode.js con Config.updateRuntime({ reasoningEffort }) tras activar el perfil de sesión, actualizando py/README.md, help/run-mode.html (es/en) y templates/project/mode-agent*.txt, con pruebas
- Last closed: M87 Mejoras sistema de agentes (2026-11-24)
- Last updated: 2026-11-24
