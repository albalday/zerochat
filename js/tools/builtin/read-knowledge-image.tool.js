/** Herramienta nativa read_knowledge_image. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'));
  else root.ChatBuiltinReadKnowledgeImageTool = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { escapeHtml, resolveDep } = Utils;
  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');

  function createLiveCard(args, ui) {
    const card = ui.createCardWrapper();
    card.innerHTML = getCards().renderCardHtml({
      titleHtml: `<span>${escapeHtml(ui.t('tool_rag_image_title'))}</span>`,
      badgeHtml: `<span class="tool-card-badge status-loading">${ui.SPINNER_SVG} <span>${escapeHtml(ui.t('tool_badge_executing'))}</span></span>`,
      bodyHtml: `<div class="tool-card-result"><code>${escapeHtml(args.imageRef || '')}</code><div class="rag-image-result"></div></div>`
    });
    return card;
  }

  function updateLiveCard(card, _args, result, elapsedMs, ui) {
    const success = result.success !== false && !result.error;
    getCards().renderStatusBadge(card.querySelector('.tool-card-badge'), success, ui.t(success ? 'tool_status_success' : 'tool_status_error', { ms: elapsedMs }));
    const resultDiv = card.querySelector('.rag-image-result');
    Utils.setText(resultDiv, success ? result.documentTitle || result.imageRef || '' : result.error || '');
    if (success && result.dataUrl) {
      const figure = card.ownerDocument.createElement('figure');
      figure.className = 'rag-image-preview';
      const img = card.ownerDocument.createElement('img');
      img.className = 'rag-image-thumb';
      img.src = result.dataUrl;
      img.alt = result.documentTitle || result.imageRef || ui.t('tool_rag_image_title');
      img.title = ui.t('image_open_tab');
      img.tabIndex = 0;
      img.setAttribute('role', 'button');
      img.loading = 'lazy';
      img.decoding = 'async';
      const open = () => Utils.openImageInNewTab(result.dataUrl);
      img.addEventListener('click', open);
      img.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });
      figure.appendChild(img);
      resultDiv.appendChild(figure);
    }
  }

  function renderHistoricalCard(args, message, ui) {
    const card = createLiveCard(args, ui);
    const imgData = message?.images?.find(item => item?.dataUrl);
    const success = Boolean(imgData) || (typeof message?.content === 'string' && message.content.startsWith('Image retrieved'));
    const result = {
      success,
      imageRef: imgData?.imageRef || args.imageRef,
      documentTitle: imgData?.documentTitle,
      page: imgData?.page,
      dataUrl: imgData?.dataUrl
    };
    updateLiveCard(card, args, result, 0, ui);
    return card;
  }

  return {
    definition: {
      name: 'read_knowledge_image',
      description: 'Retrieves an image from a RAG document to inspect it visually. Use only if you have native vision capability and the image may provide relevant information. Provide a full rag-image://docId:imgId reference obtained from the document; do not invent identifiers. If you cannot process images, do not use this tool.',
      parameters: { type: 'object', properties: { imageRef: { type: 'string', description: 'Full rag-image://docId:imgId reference obtained from a RAG document.' } }, required: ['imageRef'] }
    },
    category: 'rag',
    settings: { showInSettings: false },
    isAvailable: config => config.activeRagBranchIds.length > 0,
    execute: (args, context) => context.services.ragService.readKnowledgeImage(context.activeRagBranchIds, args),
    result: {
      toModel: (_args, result) => (result.success
        ? `Image retrieved: ${result.imageRef}${result.documentTitle ? ` (${result.documentTitle}${result.page ? `, page ${result.page}` : ''})` : ''}. Inspect it visually to answer.`
        : JSON.stringify(result)),
      toMarkdown: (args, result) => (result.success
        ? `> **read_knowledge_image** (${result.imageRef})\n\n`
        : `> **read_knowledge_image** (${args.imageRef || ''}) · ${result.error || 'Error'}\n\n`)
    },
    view: { createLiveCard, updateLiveCard, renderHistoricalCard }
  };
});
