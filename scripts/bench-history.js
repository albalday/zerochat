#!/usr/bin/env node
/**
 * Mide el coste del historial sin borrado (M63-T6): arranca zerochat.py con un directorio de datos
 * temporal, guarda N conversaciones repartidas en proyectos y mide
 *   1. zerochat/conversations/list en el servidor (tiempo y tamaño de la respuesta);
 *   2. la primera carga de la interfaz con IndexedDB vacía (sincronización completa) y la siguiente;
 *   3. el pintado de la barra lateral (vista del proyecto, vista de todos y una búsqueda).
 *
 * Uso: node scripts/bench-history.js [conversaciones=2000] [mensajes=20] [caracteres=400]
 * No toca los datos del usuario: todo vive en un directorio temporal que se borra al terminar.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createTokenDataDir, waitForServer, freePort } = require('../tests/helpers/backend-env.js');
const { getBrowser, closeGlobalBrowser } = require('../tests/helpers/browser-env.js');

const [conversations = 2000, messagesPerConversation = 20, messageChars = 400] = process.argv.slice(2).map(Number);
const PROJECTS = 10;
const repoRoot = path.resolve(__dirname, '..');
const token = 'bench-token-' + Date.now();
const ms = value => `${Math.round(value)} ms`;
const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

async function main() {
  const dataDir = createTokenDataDir(token);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn('python3', [path.join(repoRoot, 'zerochat.py'), '--port', String(port), '--no-browser', '--no-venv'], {
    cwd: repoRoot,
    env: { ...process.env, ZEROCHAT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const results = {};
  try {
    await waitForServer(baseUrl, token, server);
    const rpc = async (method, params = {}) => {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ZeroChat-Token': token },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
      const text = await response.text();
      const json = JSON.parse(text);
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return { result: json.result, bytes: text.length };
    };

    // 1. Datos: N conversaciones, una de cada once sin proyecto, de la más antigua a la más reciente.
    let started = Date.now();
    const now = Date.now();
    const body = 'x'.repeat(messageChars);
    for (let index = 0; index < conversations; index++) {
      const updatedAt = now - (conversations - index) * 60000;
      const project = index % 11 === 10 ? undefined : `/bench/proyecto-${index % PROJECTS}`;
      const messages = Array.from({ length: messagesPerConversation }, (_, position) => ({
        id: `m${index}_${position}`, role: position % 2 ? 'assistant' : 'user', content: `${position} ${body}`
      }));
      await rpc('zerochat/conversations/save', {
        conversation: { id: `bench_${index}`, title: `Conversación ${index}`, createdAt: updatedAt, updatedAt, ...(project ? { project } : {}) },
        messages
      });
    }
    results.seed = Date.now() - started;
    results.dbBytes = fs.statSync(path.join(dataDir, 'storage', 'zerochat.db')).size;

    const listRuns = [];
    let listBytes = 0;
    for (let run = 0; run < 5; run++) {
      started = performance.now();
      listBytes = (await rpc('zerochat/conversations/list')).bytes;
      listRuns.push(performance.now() - started);
    }
    results.list = Math.min(...listRuns);
    results.listBytes = listBytes;

    // 2. Interfaz servida por el propio servidor; el fragmento le da el token como al lanzarla.
    const browser = await getBrowser();
    const context = await browser.newContext({ locale: 'es-ES', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    let gets = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && (request.postData() || '').includes('"zerochat/conversations/get"')) gets++;
    });
    const loadUntilListed = async url => {
      const start = performance.now();
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(count => (window.ChatState?.get('sessions').list.length || 0) >= count, conversations, { timeout: 30 * 60000, polling: 200 });
      return performance.now() - start;
    };
    const appUrl = `${baseUrl}/zerochat.html`;
    results.firstLoad = await loadUntilListed(`${appUrl}#token=${encodeURIComponent(token)}&host=127.0.0.1&port=${port}`);
    results.firstLoadGets = gets;
    gets = 0;
    results.secondLoad = await loadUntilListed(appUrl);
    results.secondLoadGets = gets;
    results.idbBytes = await page.evaluate(async () => (await navigator.storage.estimate()).usage || 0);

    // 3. Pintado de la barra con la lista ya cargada.
    Object.assign(results, await page.evaluate(() => {
      const elements = {
        sidebarChatsList: document.getElementById('sidebar-chats-list'),
        sidebarSearchInput: document.getElementById('sidebar-search-input'),
        sidebarProjectFilter: document.getElementById('sidebar-project-filter')
      };
      const sessions = window.ChatState.get('sessions').list;
      const measure = (view, search) => {
        elements.sidebarProjectFilter.value = view;
        elements.sidebarSearchInput.value = search;
        const start = performance.now();
        window.ChatUISidebar.renderSidebarChats(elements, sessions, '', [], '/bench/proyecto-0');
        elements.sidebarChatsList.getBoundingClientRect();
        return { time: performance.now() - start, nodes: elements.sidebarChatsList.getElementsByTagName('*').length };
      };
      return { renderCurrent: measure('current', ''), renderAll: measure('all', ''), renderSearch: measure('all', '5') };
    }));
    await context.close();
  } finally {
    server.kill('SIGTERM');
    await closeGlobalBrowser();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`Historial: ${conversations} conversaciones × ${messagesPerConversation} mensajes de ${messageChars} caracteres, ${PROJECTS} proyectos`);
  console.log(`  Guardado inicial (una petición por conversación): ${ms(results.seed)}; SQLite ${mb(results.dbBytes)}`);
  console.log(`  conversations/list: ${ms(results.list)}, respuesta ${mb(results.listBytes)}`);
  console.log(`  Primera carga, IndexedDB vacía: ${ms(results.firstLoad)} con ${results.firstLoadGets} conversations/get`);
  console.log(`  Carga siguiente, ya sincronizada: ${ms(results.secondLoad)} con ${results.secondLoadGets} conversations/get`);
  console.log(`  IndexedDB del navegador: ${mb(results.idbBytes)}`);
  for (const [label, key] of [['vista del proyecto', 'renderCurrent'], ['vista de todos (plegada)', 'renderAll'], ['búsqueda "5" en todos', 'renderSearch']]) {
    console.log(`  Barra, ${label}: ${ms(results[key].time)}, ${results[key].nodes} nodos`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
