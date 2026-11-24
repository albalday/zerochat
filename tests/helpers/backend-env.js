const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// El backend no admite fijar el token por argumentos: se deja preparado como
// token diario en un directorio de datos temporal que borra quien lo pide.
function createTokenDataDir(token) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-token-'));
  const now = new Date();
  const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-');
  fs.mkdirSync(path.join(dataDir, 'config'), { mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'config', 'token.json'), JSON.stringify({ token, date: today }), { mode: 0o600 });
  return dataDir;
}

// En las pruebas, el directorio se borra al terminar la prueba o el describe desde el que se pide.
function tokenDataDir(token) {
  const dataDir = createTokenDataDir(token);
  test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
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

/**
 * Espera a que `serverProc` anuncie en su cabecera que escucha en `baseUrl` (la imprime tras abrir el
 * puerto y la vuelca con flush) y lo confirma con un latido: sin sondear el puerto.
 */
async function waitForServer(baseUrl, testToken, serverProc, maxWaitMs = 15000) {
  let output = '';
  let cleanup = () => {};
  const listening = new Promise((resolve, reject) => {
    const onData = chunk => {
      output += chunk.toString();
      const announced = output.match(/Servidor HTTP\s*:\s*(\S+)/);
      if (announced?.[1] === baseUrl) resolve();
      else if (announced) reject(new Error(`escucha en ${announced[1]}`));
    };
    const onErr = chunk => { output += chunk.toString(); };
    // 'close' llega tras vaciar stdout y stderr: el error de arranque ya está en la salida.
    const onExit = code => reject(new Error(`terminó con código ${code}`));
    const timer = setTimeout(() => reject(new Error(`no arrancó en ${maxWaitMs} ms`)), maxWaitMs);
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', onErr);
    serverProc.once('close', onExit);
    cleanup = () => {
      clearTimeout(timer);
      serverProc.stdout.off('data', onData);
      serverProc.stderr.off('data', onErr);
      serverProc.off('close', onExit);
    };
  });
  try {
    await listening;
  } catch (error) {
    assert.fail(`El servidor zerochat.py no está disponible en ${baseUrl}: ${error.message}. Salida: ${output}`);
  } finally {
    cleanup();
  }
  const probe = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(testToken ? { 'X-ZeroChat-Token': testToken } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'zerochat/heartbeat', params: {} })
  });
  assert.ok(probe.ok, `El latido de arranque respondió ${probe.status}`);
}

// Intentos de arranque de startServer: cada uno con otro puerto de freePort().
const START_ATTEMPTS = 3;

/**
 * Arranca zerochat.py con `spawnServer(port)` en un puerto de freePort() y espera su cabecera; devuelve
 * { baseUrl, serverProc }. freePort() libera el puerto antes de que zerochat.py lo ocupe: si entretanto otro
 * proceso de la suite lo toma, el servidor termina con "Address already in use" y se repite con otro puerto.
 */
async function startServer(spawnServer, testToken) {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const serverProc = spawnServer(port);
    try {
      await waitForServer(baseUrl, testToken, serverProc);
      return { baseUrl, serverProc };
    } catch (error) {
      serverProc.kill('SIGTERM');
      if (attempt >= START_ATTEMPTS || !/Address already in use/.test(error.message)) throw error;
    }
  }
}

module.exports = { createTokenDataDir, tokenDataDir, startServer, freePort };
