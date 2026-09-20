const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles } = require('../helpers/browser-env.js');

describe('Browser UI - composer', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - el fallback de contexto no invalida el formulario de envío', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem('zerochat_runtime_config_v2', JSON.stringify({
      activeProfile: { id: 'profile:local', name: 'Local chat' }, apiType: 'openai', apiUrl: 'http://localhost:1234/v1', model: 'google/gemma-4-26b-a4b-qat'
    })));
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.click('#active-profile-trigger');
    await page.click('[data-profile-id="profile:remote"]');
    await page.fill('#user-input', 'test');

    const formState = await page.evaluate(() => ({
      valid: document.getElementById('chat-form').checkValidity(),
      fallback: document.getElementById('context-limit-override-input').value,
      activeProfileName: document.getElementById('active-profile-name').textContent
    }));

    assert.equal(formState.fallback, '1000K');
    assert.equal(formState.valid, true);
    assert.equal(formState.activeProfileName, 'Remoto chat', 'El selector debe reflejar el perfil activo tras aplicarlo');
  } finally {
    await browser.close();
  }
});

test('Browser UI - composer se expande y mantiene controles de generación y razonamiento', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    // 1. Validar autoexpansión del textarea al introducir múltiples líneas
    const initialHeight = await page.$eval('#user-input', el => el.offsetHeight);
    await page.fill('#user-input', 'Línea 1\nLínea 2\nLínea 3\nLínea 4\nLínea 5');
    await page.dispatchEvent('#user-input', 'input');

    const expandedHeight = await page.$eval('#user-input', el => el.offsetHeight);
    assert.ok(expandedHeight > initialHeight, `La altura del textarea debe crecer con contenido multilínea (de ${initialHeight}px a ${expandedHeight}px)`);

    // Limpiar input y verificar vuelta a altura mínima
    await page.fill('#user-input', '');
    await page.dispatchEvent('#user-input', 'input');
    const resetHeight = await page.$eval('#user-input', el => el.offsetHeight);
    assert.ok(resetHeight <= initialHeight, 'Al vaciar el texto debe volver a la altura mínima');

    // 2. Validar menú desplegable de razonamiento integrado
    await page.click('#btn-reasoning');
    const isMenuOpen = await page.$eval('#reasoning-menu', el => el.style.display !== 'none');
    assert.ok(isMenuOpen, 'Pulsar #btn-reasoning debe desplegar el menú de opciones');

    // 3. Validar metamorfosis dinámica entre botón de Send y Stop
    // Al simular streaming activando stop-stream:
    await page.evaluate(() => {
      const stopBtn = document.getElementById('btn-stop-stream');
      stopBtn.style.display = 'inline-flex';
    });

    const isSendHiddenDuringStop = await page.evaluate(() => {
      const sendBtn = document.getElementById('btn-send');
      return getComputedStyle(sendBtn).display === 'none';
    });
    assert.ok(isSendHiddenDuringStop, 'Cuando el botón de detener está visible, el botón de envío debe ocultarse automáticamente');

    // Restaurar estado inactivo
    await page.evaluate(() => {
      const stopBtn = document.getElementById('btn-stop-stream');
      stopBtn.style.display = 'none';
    });

    const isSendVisibleAgain = await page.evaluate(() => {
      const sendBtn = document.getElementById('btn-send');
      return getComputedStyle(sendBtn).display !== 'none';
    });
    assert.ok(isSendVisibleAgain, 'Al terminar el streaming, el botón de envío vuelve a ser visible');

  } finally {
    await browser.close();
  }
});

test('Browser UI - Rediseño Composer: dos partes lógicas, barra inferior con controles y apertura directa de tabs', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar la estructura de dos filas dentro de #chat-form
    const structure = await page.evaluate(() => {
      const form = document.querySelector('#chat-form');
      const topRow = form?.querySelector('.composer-top-row');
      const bottomRow = form?.querySelector('.composer-bottom-row');
      const userInput = topRow?.querySelector('#user-input');
      const controlsLeft = bottomRow?.querySelector('.composer-controls-left');
      const actionsRight = bottomRow?.querySelector('.composer-actions-right');

      const btnAttach = controlsLeft?.querySelector('#btn-attach-file');
      const btnReasoning = controlsLeft?.querySelector('#btn-reasoning');
      const btnRag = controlsLeft?.querySelector('#btn-open-rag');

      const tokensBadge = actionsRight?.querySelector('#connection-tokens-badge');
      const btnStop = actionsRight?.querySelector('#btn-stop-stream');
      const btnSend = actionsRight?.querySelector('#btn-send');

      // Los botones de agente y MCP ya no están en el composer
      const btnTools = controlsLeft?.querySelector('#btn-composer-tools');
      const btnMcp = controlsLeft?.querySelector('#btn-composer-mcp');

      return {
        hasTopRow: !!topRow,
        hasBottomRow: !!bottomRow,
        userInputInTopRow: !!userInput,
        hasControlsLeft: !!controlsLeft,
        hasActionsRight: !!actionsRight,
        hasBtnAttach: !!btnAttach,
        hasBtnReasoning: !!btnReasoning,
        hasBtnRag: !!btnRag,
        ragIcon: btnRag?.querySelector('svg use')?.getAttribute('href'),
        hasTokensBadge: !!tokensBadge,
        hasBtnStop: !!btnStop,
        hasBtnSend: !!btnSend,
        hasBtnTools: !!btnTools,
        hasBtnMcp: !!btnMcp
      };
    });

    assert.ok(structure.hasTopRow, 'El composer debe contener .composer-top-row');
    assert.ok(structure.hasBottomRow, 'El composer debe contener .composer-bottom-row');
    assert.ok(structure.userInputInTopRow, '#user-input debe estar en la fila superior');
    assert.ok(structure.hasBtnAttach, 'El botón adjuntar debe estar en los controles inferiores izquierdos');
    assert.ok(structure.hasBtnReasoning, 'El botón de razonamiento debe estar en los controles inferiores izquierdos');
    assert.ok(structure.hasBtnRag, 'El botón de RAG debe estar en los controles inferiores izquierdos');
    assert.equal(structure.ragIcon, '#icon-layers', 'El botón de RAG debe usar el icono de conocimiento');
    assert.ok(structure.hasTokensBadge, 'El contador de tokens debe estar a la derecha');
    assert.ok(structure.hasBtnSend, 'El botón enviar debe estar a la derecha');
    assert.equal(structure.hasBtnTools, false, 'El botón de tools no debe estar en el composer');
    assert.equal(structure.hasBtnMcp, false, 'El botón de MCP no debe estar en el composer');

    // 2. Probar que pulsar #btn-open-rag abre el diálogo de RAG
    await page.click('#btn-open-rag');
    await page.waitForFunction(() => document.getElementById('rag-modal')?.open);
    const isRagOpen = await page.$eval('#rag-modal', el => el.open);
    assert.ok(isRagOpen, 'El botón #btn-open-rag en el composer debe abrir #rag-modal');

    // Cerrar diálogo de RAG
    await page.click('#btn-close-rag');
    await page.waitForFunction(() => !document.getElementById('rag-modal')?.open);
  } finally {
    await browser.close();
  }
});

test('Browser UI - composer compacto en móvil mantiene placeholder y controles accesibles', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 700 }, isMobile: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    for (const language of ['es', 'en']) {
      const metrics = await page.evaluate(language => {
        window.ChatI18n.setLanguage(language, false);
        const input = document.getElementById('user-input');
        const controls = ['btn-attach-file', 'btn-reasoning', 'btn-open-rag'];
        const buttons = controls.map(id => document.getElementById(id));
        const rects = buttons.map(button => button.getBoundingClientRect());
        const inputStyle = getComputedStyle(input);
        return {
          placeholder: input.placeholder,
          inputHeight: input.getBoundingClientRect().height,
          lineHeight: parseFloat(inputStyle.lineHeight),
          hasIcons: buttons.every(button => !!button.querySelector('svg use')),
          hasNames: buttons.every(button => !!(button.getAttribute('aria-label') || button.getAttribute('aria-labelledby'))),
          sameRow: rects.every(rect => Math.abs(rect.top - rects[0].top) < 1),
          withinViewport: rects.every(rect => rect.left >= 0 && rect.right <= innerWidth)
        };
      }, language);
      assert.equal(metrics.placeholder, language === 'es' ? 'Escribe un mensaje...' : 'Write a message...');
      assert.ok(metrics.inputHeight < metrics.lineHeight * 2, 'El placeholder debe caber en una línea');
      assert.equal(metrics.hasIcons, true);
      assert.equal(metrics.hasNames, true);
      assert.equal(metrics.sameRow, true);
      assert.equal(metrics.withinViewport, true);
    }

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('UI - Indicador de progreso de generación es invisible sin ciclo activo y visible durante el ciclo', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    // 1. En reposo (sin generar), el elemento debe estar invisible
    const initialVisibility = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      const isGenerating = window.ChatState.get('streaming')?.isGenerating;
      return {
        hidden: el.hidden,
        display: getComputedStyle(el).display,
        isGenerating: Boolean(isGenerating)
      };
    });
    assert.equal(initialVisibility.hidden, true, 'El indicador debe estar oculto en reposo');
    assert.equal(initialVisibility.display, 'none', 'El indicador debe tener display none');
    assert.equal(initialVisibility.isGenerating, false, 'No debe haber ciclo de generación activo');

    // 2. Intentar emitir estado sin ciclo activo debe ser ignorado (infraestructura general protegida)
    await page.evaluate(() => {
      window.ChatApp.setGenerationStatus('Mensaje fuera de ciclo');
    });
    const ignoredOutsideCycle = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      return el.hidden;
    });
    assert.equal(ignoredOutsideCycle, true, 'No debe volverse visible si no hay un ciclo de chat en proceso');

    // 3. Al activarse el ciclo de chat, se hace visible y refleja mensajes de cualquier módulo
    await page.evaluate(() => {
      window.ChatState.set('streaming', { isGenerating: true, status: 'streaming' });
      window.ChatApp.setGenerationStatus('Analizando documentos con RAG...');
    });
    const ragState = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      const text = el.querySelector('.generation-status-text')?.textContent;
      return { hidden: el.hidden, text };
    });
    assert.equal(ragState.hidden, false, 'El indicador debe ser visible durante el ciclo');
    assert.equal(ragState.text, 'Analizando documentos con RAG...');

    // 4. Otro módulo (ej. herramientas/agente) anuncia un nuevo estado
    await page.evaluate(() => {
      window.ChatApp.setGenerationStatus({ phase: 'tool', text: 'Ejecutando web_search...' });
    });
    const toolText = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      return el.querySelector('.generation-status-text')?.textContent;
    });
    assert.equal(toolText, 'Ejecutando web_search...');

    // 4b. Transición de herramienta a pensamiento: debe cambiar a pensando y no mantener el texto de la herramienta
    await page.evaluate(() => {
      window.ChatApp.setGenerationStatus({ phase: 'thinking' });
    });
    const thinkingState = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      const text = el.querySelector('.generation-status-text')?.textContent || '';
      return { phase: el.dataset.phase, text, includesToolText: text.includes('web_search') };
    });
    assert.equal(thinkingState.phase, 'thinking');
    assert.match(thinkingState.text, /Pensando|Thinking/i);
    assert.equal(thinkingState.includesToolText, false, 'El texto del tool no debe persistir durante la fase de pensamiento');

    // 5. Al finalizar el ciclo de chat, vuelve inmediatamente a invisible
    await page.evaluate(() => {
      window.ChatState.set('streaming', { isGenerating: false, status: 'idle' });
    });
    const finalVisibility = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      return {
        hidden: el.hidden,
        display: getComputedStyle(el).display
      };
    });
    assert.equal(finalVisibility.hidden, true, 'El indicador debe volver a estar oculto al finalizar el ciclo');
    assert.equal(finalVisibility.display, 'none');
  } finally {
    await browser.close();
  }
});
});
