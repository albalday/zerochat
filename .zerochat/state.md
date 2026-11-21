# Current state
- Milestone: M83 Esperas síncronas en lugar de sondeo (restos tras M81)
- Next task: M83-T3 Backend+UI: zerochat/jobs/log y zerochat/jobs/get por key con wait_ms esperan a que el comando se registre (condición en JobManager notificada al registrar, con tope LONG_POLL_MAX_WAIT_MS y despertar en el cierre) en lugar de fallar al instante. Consumidor real: la primera lectura de la tarjeta en vivo, que deja la pausa ciega initialDelayMs=LOG_RETRY_DELAY_MS de command-card.js; revisar también el delay previo de followLog (~735) y quitarlo si no protege nada. Prueba en el borde: clave registrada durante la espera despierta y clave inexistente vuelve al vencer
- Last updated: 2026-11-21
