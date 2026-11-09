# Plan

<!-- Hitos M1 a M51 archivados en .zerochat/archive/ -->

## M52 Robustez del transporte web en servidor: cabeceras de navegación y cadencia frente a retos anti-bot: closed 2026-11-08

## M53 Simplificación de la suite de pruebas, retirada de tests obsoletos y optimización de WebLLM: closed 2026-11-09

## M54 Mejoras al modo proyecto: normalización modal del panel de razonamiento y simplificación de memoria: closed 2026-11-09

## M55 Mejoras simples

Goal: Implementar pequeñas mejoras de usabilidad y ajustes sencillos en la interfaz y funcionamiento general.
Done when: Se completan las tareas de mejora acordadas manteniendo la suite de pruebas en verde.
- [x] M55-T1 Feedback en el botón de actualizar datos del panel de razonamiento cambiando su texto por "datos actualizados" (2026-11-09)
- [x] M55-T2 Al abrir el panel de selección de perfiles, si hay modo de ejecución con servidor activo, mostrar la vista de perfiles de servidor (2026-11-09)
- [x] M55-T3 El tool search_files se muestra en rojo como error cuando no encuentra resultados. No debería: la ausencia de coincidencias es un resultado válido, no un fallo. Analizar el path de renderizado y corregir el estado visual. (dropped: no ocurre en realidad, la ausencia de resultados no genera error visual)
- [x] M55-T4 User-Agent actualizado y variable: el DEFAULT_USER_AGENT global pasa a una versión de Chrome actual, se usa en las peticiones web del backend y en la inicialización de Playwright, y se sustituye por el User-Agent de la primera petición recibida del frontend (variabilidad; cubre --prompt/--conversation con el valor por defecto). (2026-11-09)
- [x] M55-T5 Cadencia de DuckDuckGo por respuesta: las peticiones a duckduckgo.com se serializan esperando al menos 2 s desde la RESPUESTA anterior (no desde el inicio), el timestamp se inicializa al arrancar el backend, y las peticiones en paralelo se escalonan sumando 5 s para no coincidir. (2026-11-09)
- [x] M55-T6 Herramienta propia de diff para casos de ejecución remota (2026-11-09)


