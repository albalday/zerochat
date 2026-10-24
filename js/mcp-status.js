/**
 * Estados de un servicio MCP externo que informa el servidor local (`status` de cada servicio en
 * `servers`) y las únicas lecturas que hace de ellos el cliente.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatMcpStatus = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Los de service_status en py/ee-mcp.py; tests/fixtures/mcp/contract.json comprueba que coinciden. */
  const SERVICE_STATUSES = Object.freeze(['stopped', 'installing', 'starting', 'running', 'error']);

  /** Arrancando: instala sus dependencias o espera el handshake (y la autorización OAuth). */
  const isBusy = status => status === 'installing' || status === 'starting';
  /** En marcha con sus herramientas registradas: es el único que se puede detener. */
  const isRunning = status => status === 'running';
  /** En marcha o arrancando: no hay que volver a arrancarlo. */
  const isActive = status => isRunning(status) || isBusy(status);
  /** Detenido o caído; sin conexión (status null) no se puede arrancar. */
  const canStart = status => status === 'stopped' || status === 'error';

  return Object.freeze({ SERVICE_STATUSES, isBusy, isRunning, isActive, canStart });
});
