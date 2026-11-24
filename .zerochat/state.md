# Current state
- Milestone: M88 Ajustes de control de agentes
- Next task: M88-T4 Control de bucles en AgentRuntime (js/agent-core.js) ante esperas con progreso real (check_command y check_agents): no contabilizar como repetición estancada una llamada a check_command o check_agents que observe avance real sobre una ejecución en marcha (en check_command: status=='running' con new_output no vacío o transición a final; en check_agents: returned_because=='agent_changed' o algún agente en status=='running' cuya actividad updated_at/step_text/usage haya avanzado respecto a la llamada anterior), manteniendo loop_detected tras 5 repeticiones cuando el comando/agente ya terminó o lleva 5 esperas agotadas sin ningún avance, con pruebas en tests/integration/test_agent_runtime.js
- Last closed: M87 Mejoras sistema de agentes (2026-11-24)
- Last updated: 2026-11-24
