# Playwright MCP

Ejemplo de catálogo para el plan de ZeroChat. Esta ficha no instala nada por sí sola. Requiere el bootstrap y gestor descritos en `scripts/mcp/README.md` y una release con locks e integridades generados y probados.

El servidor oficial es [`@playwright/mcp`, de Microsoft](https://github.com/microsoft/playwright-mcp). Necesita Node.js; el entorno Python es para el gestor. La receta propone instalación npm privada y Chromium dentro de `~/.zerochat/mcp`, sin instalaciones globales. Si faltan bibliotecas del sistema, se mostrará la intervención necesaria.

Al pulsar **Arrancar servicios MCP externos**, el gestor prepara y activa este servicio si está habilitado. El navegador se ejecuta sin ventana y con perfil aislado. Las herramientas y sus parámetros se descubren mediante MCP; no están definidos en el bundle ni en esta ficha.

Para comprobarlo, navegar mediante la herramienta publicada a una página local de prueba e interactuar con un botón. Después detener y volver a arrancar sin red: las instalaciones válidas deben reutilizarse. La separación de perfiles entre conversaciones debe implementarse en el gestor.
