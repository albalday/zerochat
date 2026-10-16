/** Herramienta nativa download_image. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'));
  else root.ChatBuiltinDownloadImageTool = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { escapeHtml, resolveDep } = Utils;
  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');
  const SUCCESS_MODEL_PREFIX = 'Image retrieved:';

  function createLiveCard(args, ui) {
    const card = ui.createCardWrapper();
    const url = getCards().getUrlArg(args);
    card.innerHTML = getCards().renderCardHtml({
      className: 'web-request-card image-request-card',
      titleHtml: `<span>${escapeHtml(ui.t('tool_image_title'))}</span>`,
      badgeHtml: `<span class="tool-card-badge status-loading">${ui.SPINNER_SVG} <span>${escapeHtml(ui.t('tool_badge_downloading'))}</span></span>`,
      bodyHtml: `<div class="tool-card-result"><div class="url-badge"><a href="${Utils.sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div><div class="web-image-result"></div></div>`
    });
    return card;
  }

  function updateLiveCard(card, _args, result, elapsedMs, ui) {
    const success = result.success !== false && !result.error;
    getCards().renderStatusBadge(card.querySelector('.tool-card-badge'), success, ui.t(success ? 'tool_status_success' : 'tool_status_error', { ms: elapsedMs }));
    const resultDiv = card.querySelector('.web-image-result');
    Utils.setText(resultDiv, success ? `${result.mimeType || 'image'} · ${Utils.formatBytes(result.byteSize || 0)}` : result.error || '');
    if (success && result.dataUrl) {
      const figure = card.ownerDocument.createElement('figure');
      figure.className = 'rag-image-preview';
      const img = card.ownerDocument.createElement('img');
      img.className = 'rag-image-thumb';
      img.src = result.dataUrl;
      img.alt = result.fileName || result.url || ui.t('tool_image_title');
      img.loading = 'lazy';
      img.decoding = 'async';
      Utils.makeImageOpenable(img, result.dataUrl, ui.t('image_open_tab'));
      figure.appendChild(img);
      resultDiv.appendChild(figure);
    }
  }

  function renderHistoricalCard(args, message, ui) {
    const card = createLiveCard(args, ui);
    const imgData = message?.images?.find(item => item?.dataUrl);
    const success = Boolean(imgData) || (typeof message?.content === 'string' && message.content.startsWith(SUCCESS_MODEL_PREFIX));
    const result = {
      success,
      url: imgData?.url || getCards().getUrlArg(args),
      mimeType: imgData?.mimeType,
      byteSize: imgData?.byteSize,
      dataUrl: imgData?.dataUrl
    };
    updateLiveCard(card, args, result, 0, ui);
    return card;
  }

  return {
    definition: {
      name: 'download_image',
      description: 'Downloads a web image (PNG, JPEG, WebP, GIF) from a URL to visually inspect it. Use only if you have native vision capability.',
      parameters: { type: 'object', properties: { url: { type: 'string', description: 'Direct web URL of the image to download.' } }, required: ['url'] }
    },
    aliases: ['download_web_image', 'fetch_image', 'get_image'],
    category: 'web',
    settings: { titleKey: 'agent_image_title', descKey: 'agent_image_desc' },
    promptGuide: '- `download_image(url="...")`: Downloads an image from a URL into the prompt context for visual inspection. Use only with vision.',
    execute: (args, context) => context.services.webBrowser.fetchImage(getCards().getUrlArg(args)),
    result: {
      toModel: (args, result) => (result.success
        ? `${SUCCESS_MODEL_PREFIX} ${result.url || getCards().getUrlArg(args)}. Inspect it visually to answer.`
        : JSON.stringify(result)),
      toMarkdown: args => `> **download_image**\n> URL: "${getCards().getUrlArg(args)}"\n\n`
    },
    view: { createLiveCard, updateLiveCard, renderHistoricalCard }
  };
});

