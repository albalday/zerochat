const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// El backend no admite fijar el token por argumentos: las pruebas lo dejan
// preparado como token diario en un directorio de datos temporal.
const tokenDataDirs = [];
function tokenDataDir(token) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-token-'));
  const now = new Date();
  const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-');
  fs.mkdirSync(path.join(dataDir, 'config'), { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'config', 'token.json'), JSON.stringify({ token, date: today }), { mode: 0o600 });
  if (tokenDataDirs.length === 0) {
    test.after(() => {
      for (const dir of tokenDataDirs) fs.rmSync(dir, { recursive: true, force: true });
    });
  }
  tokenDataDirs.push(dataDir);
  return dataDir;
}

// Puerto libre asignado por el sistema: evita colisiones con otros procesos o suites en paralelo.
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, testToken, serverProc, maxWaitMs = 15000) {
  const start = Date.now();
  let serverError = '';
  if (serverProc) {
    serverProc.stderr?.on('data', chunk => { serverError += chunk.toString(); });
    serverProc.stdout?.on('data', chunk => { serverError += chunk.toString(); });
  }
  while (Date.now() - start < maxWaitMs) {
    try {
      const probeRes = await fetch(`${baseUrl}/`, {
        headers: testToken ? { 'X-ZeroChat-Token': testToken } : {}
      });
      if (probeRes.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`El servidor zerochat.py no arrancó en ${baseUrl} tras ${maxWaitMs}ms. Error: ${serverError}`);
}

module.exports = { tokenDataDir, waitForServer, freePort };
