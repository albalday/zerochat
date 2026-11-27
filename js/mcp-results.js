/**
 * Resultados de las herramientas MCP: normaliza la respuesta de tools/call (directa o tras autorización)
 * con su tope de tamaño, separa del texto la captura que una herramienta devuelva en `image_base64`
 * para entregarla al modelo como evidencia visual, valida las imágenes antes de pintarlas y da el texto
 * del resultado para el modelo, la tarjeta y la exportación en Markdown.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatMcpResults = factory(root.ChatUtils, root.ChatI18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { SAFE_IMAGE_MIME_TYPES } = Utils;

  const MAX_OUTPUT_LENGTH = 60000;
  const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024;

  /** Imagen base64 segura (tipo permitido y tamaño acotado) como data URL; null si no lo es. */
  function toSafeImageDataUrl(base64, mimeType) {
    const type = String(mimeType || 'image/png').toLowerCase();
    if (!SAFE_IMAGE_MIME_TYPES.has(type) || typeof base64 !== 'string' || base64.length === 0 ||
        base64.length > MAX_IMAGE_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return null;
    }
    return `data:${type};base64,${base64}`;
  }

  function parseDataUrl(value) {
    const match = String(value || '').match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i);
    return match ? { mimeType: match[1].toLowerCase(), base64: match[2] } : null;
  }

  /**
   * Una herramienta del servidor local puede devolver una captura en `image_base64`: se separa del
   * texto para entregarla al modelo como evidencia visual y no como base64 dentro del contexto.
   */
  function extractImageFromMcpText(textOutput) {
    let parsed;
    try {
      parsed = JSON.parse(textOutput);
    } catch (_) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.image_base64 !== 'string') return null;
    const embedded = parseDataUrl(parsed.image_base64);
    const mimeType = String(embedded?.mimeType || parsed.mime_type || parsed.mimeType || 'image/png').toLowerCase();
    const imageBase64 = embedded?.base64 || parsed.image_base64;
    if (!toSafeImageDataUrl(imageBase64, mimeType)) return null;
    parsed.image_base64 = `[Base64 image (${mimeType}), length: ${imageBase64.length} chars - attached as visual evidence]`;
    return { content: JSON.stringify(parsed, null, 2), imageBase64, mimeType };
  }

  function getSafeMcpImageDataUrl(result) {
    return toSafeImageDataUrl(result?.image_base64, result?.mime_type);
  }

  function getSafeMcpImageFromMessage(message) {
    const image = message?.images?.find(item => item?.dataUrl);
    const parsed = parseDataUrl(image?.dataUrl);
    return parsed ? toSafeImageDataUrl(parsed.base64, parsed.mimeType) : null;
  }

  /** Texto del resultado de una herramienta MCP para el modelo, la tarjeta y la exportación. */
  function getResultText(result) {
    if (result.content) return result.content;
    if (result.rawResult) return typeof result.rawResult === 'string' ? result.rawResult : JSON.stringify(result.rawResult, null, 2);
    return result.error || I18n.t('tool_no_output');
  }

  /**
   * Extrae la primera imagen segura de un bloque MCP estándar `{ type: 'image', data, mimeType }`.
   */
  function extractImageFromMcpContent(content) {
    if (!Array.isArray(content)) return null;
    for (const item of content) {
      if (item?.type !== 'image' || typeof item.data !== 'string') continue;
      const embedded = parseDataUrl(item.data);
      const mimeType = String(embedded?.mimeType || item.mimeType || item.mime_type || 'image/png').toLowerCase();
      const imageBase64 = embedded?.base64 || item.data.replace(/\s+/g, '');
      if (toSafeImageDataUrl(imageBase64, mimeType)) {
        return { imageBase64, mimeType, item };
      }
    }
    return null;
  }

  /**
   * Normaliza la respuesta de ejecución de una herramienta MCP (directa o tras autorización).
   */
  function formatToolCallResult(result, { name = '', serverName = '', args = {}, elapsed = 0 } = {}) {
    const embeddedImage = extractImageFromMcpContent(result?.content);
    let textOutput = '';
    if (Array.isArray(result?.content)) {
      textOutput = result.content.map(item => {
        if (item.type === 'text') return item.text || '';
        if (item.type === 'image') {
          return item === embeddedImage?.item
            ? `[Embedded image: ${embeddedImage.mimeType} - attached as visual evidence]`
            : `[Embedded image: ${item.mimeType || 'image/png'} (omitted: unsupported format or exceeds size limit)]`;
        }
        if (item.type === 'resource') return `[Resource: ${item.resource?.uri || 'URI'}]\n${item.resource?.text || ''}`;
        return JSON.stringify(item);
      }).join('\n\n').trim();
    } else if (typeof result === 'string') {
      textOutput = result;
    } else if (result) {
      textOutput = JSON.stringify(result, null, 2);
    }

    // Llamada que el servidor no ejecutó: un reto que responde la interfaz o, en una ejecución desatendida, una pausa
    // que cierra el turno hasta que la persona la apruebe (AgentCore.ToolExecutor).
    const pendingCall = () => ({
      success: false,
      toolName: result.toolName || name,
      serverName: result.serverName || serverName,
      serverId: result.serverId || '',
      arguments: result.arguments || args,
      ruleOffer: result.ruleOffer,
      details: result.details,
      content: textOutput,
      rawResult: result,
      executionTimeMs: elapsed
    });
    if (result?.requiresAuthorization) return { ...pendingCall(), requiresAuthorization: true, challengeId: result.challengeId };
    if (result?.awaitingApproval) return { ...pendingCall(), awaitingApproval: true };

    const extractedImage = embeddedImage || extractImageFromMcpText(textOutput);
    if (!embeddedImage && extractedImage) textOutput = extractedImage.content;
    if (textOutput.length > MAX_OUTPUT_LENGTH) {
      textOutput = textOutput.slice(0, MAX_OUTPUT_LENGTH) + '\n\n[... MCP content truncated due to size limit ...]';
    }

    const isError = result?.isError === true;
    return {
      success: !isError,
      isError,
      content: textOutput,
      rawResult: result,
      ...(extractedImage ? { image_base64: extractedImage.imageBase64, mime_type: extractedImage.mimeType } : {}),
      executionTimeMs: elapsed
    };
  }

  /** Llamada y resultado de una herramienta MCP como cita en Markdown para la exportación. */
  function formatMcpMarkdown(toolName, args, result, serverName) {
    const argStr = args && Object.keys(args).length ? JSON.stringify(args, null, 2) : '';
    const parts = [`> **${toolName}** (*${serverName}*)`];
    if (argStr) parts.push(`> \`\`\`json\n> ${argStr.split('\n').join('\n> ')}\n> \`\`\``);
    parts.push(`> \`\`\`\n> ${String(getResultText(result)).split('\n').join('\n> ')}\n> \`\`\``);
    return parts.join('\n');
  }

  return {
    formatToolCallResult,
    formatMcpMarkdown,
    getResultText,
    getSafeMcpImageDataUrl,
    getSafeMcpImageFromMessage
  };
});
