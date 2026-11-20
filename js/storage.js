/**
 * Almacenamiento de ZeroChat (ChatStorage):
 * - Preferencias y documentos ligeros en localStorage, con el prefijo propio de la aplicación.
 * - Sesión efímera del backend local en una cookie.
 * - Conversaciones y mensajes en IndexedDB (ZeroChatDB), en el orden de la conversación.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./storage-db.js'));
  } else {
    root.ChatStorage = factory(root.ChatUtils, root.ZeroChatDB);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, Database) {
  'use strict';

  const { createId, normalizeBackendUrl, resolveDep } = Utils;
  const { STORES, openDatabase, requestResult, transactionDone, deleteByIndex, getAllByIndex } = Database;

  const STORAGE_PREFIX = 'zerochat_';
  const BACKEND_SESSION_COOKIE = 'zerochat_backend_session_v1';
  const BACKEND_SESSION_MAX_AGE_SECONDS = 26 * 60 * 60;
  const CONVERSATION_SAVE_CHUNK_BYTES = 512 * 1024;
  const textEncoder = new TextEncoder();
  const utf8ByteLength = text => textEncoder.encode(text).length;
  const rpcRequestByteSize = (method, params) => utf8ByteLength(JSON.stringify({ jsonrpc: '2.0', id: 999999, method, params }));
  // Campos opcionales de un mensaje que se guardan cuando están presentes.
  const OPTIONAL_MESSAGE_FIELDS = ['tool_calls', 'tool_call_id', 'name', 'stats', 'contextDateAnchor', 'images', 'commandNotes', '_isSummaryBlock', '_compressedMetadata'];
  let lastClearAllStorageError = '';
  const memoryStorageFallback = new Map();
  const syncedBlobIds = new Set();
  let syncedBlobClient;

  function ensureBlobSyncCache() {
    const mcp = getMCP();
    const client = mcp?.manager?.clients?.get?.(mcp.PROXY_ID || 'mcp_proxy') || null;
    if (client !== syncedBlobClient) {
      syncedBlobIds.clear();
      syncedBlobClient = client;
    }
  }

  function getWebStorage() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (_) {
      // Web storage unavailable or blocked by environment
    }
    return {
      getItem: key => memoryStorageFallback.get(key) ?? null,
      setItem: (key, value) => memoryStorageFallback.set(key, String(value ?? '')),
      removeItem: key => memoryStorageFallback.delete(key)
    };
  }

  function setStorageItem(name, value) {
    try {
      getWebStorage().setItem(`${STORAGE_PREFIX}${name}`, String(value ?? ''));
    } catch (error) {
      console.warn(`[ChatStorage] Could not save ${name} in localStorage:`, error);
    }
  }

  const getStorageItem = name => {
    try {
      return getWebStorage().getItem(`${STORAGE_PREFIX}${name}`);
    } catch (_) {
      return null;
    }
  };

  const deleteStorageItem = name => {
    try {
      getWebStorage().removeItem(`${STORAGE_PREFIX}${name}`);
    } catch (_) {
      // Storage unavailable or read-only
    }
  };

  /** Sesión con el backend: su URL y el token diario que dio al abrir la página o al identificarse. */
  function normalizeBackendSession(session) {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
    const token = typeof session.token === 'string' ? session.token : '';
    const url = normalizeBackendUrl(session.url);
    if (!token || token.length > 512 || token.trim() !== token || /[\u0000-\u001f\u007f]/.test(token)) return null;
    return url ? { token, url } : null;
  }

  // Con file:// no hay cookies: el backend local solo existe cuando la página se sirve por HTTP.
  const cookiesAvailable = () => typeof document !== 'undefined' && location.protocol !== 'file:';

  function writeBackendSessionCookie(value, maxAgeSeconds) {
    const secure = location.protocol === 'https:' ? ';Secure' : '';
    document.cookie = `${BACKEND_SESSION_COOKIE}=${encodeURIComponent(value)};Max-Age=${maxAgeSeconds};Path=/;SameSite=Strict${secure}`;
  }

  function setBackendSession(session, maxAgeSeconds = BACKEND_SESSION_MAX_AGE_SECONDS) {
    const normalized = normalizeBackendSession(session);
    if (!normalized || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || !cookiesAvailable()) return false;
    writeBackendSessionCookie(JSON.stringify(normalized), maxAgeSeconds);
    return getBackendSession() !== null;
  }

  function getBackendSession() {
    if (!cookiesAvailable()) return null;
    const prefix = `${BACKEND_SESSION_COOKIE}=`;
    const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
    if (!cookie) return null;
    try {
      return normalizeBackendSession(JSON.parse(decodeURIComponent(cookie.slice(prefix.length))));
    } catch (_) {
      return null;
    }
  }

  function loadRuntimeConfigV2() {
    const raw = getStorageItem('runtime_config_v2');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function saveRuntimeConfigV2(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('The runtime configuration must be an object.');
    }
    setStorageItem('runtime_config_v2', JSON.stringify(config));
    return true;
  }

  const MAX_PROJECT_ENVIRONMENTS = 50;

  function loadProjectEnvironments() {
    const raw = getStorageItem('project_environments_v1');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveProjectEnvironment(projectKey, environment) {
    const key = String(projectKey || '').trim() || 'general';
    if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
      throw new Error('The project environment must be an object.');
    }
    const all = { ...loadProjectEnvironments(), [key]: environment };
    const keys = Object.keys(all);
    if (keys.length > MAX_PROJECT_ENVIRONMENTS) {
      keys
        .filter(k => k !== key)
        .sort((a, b) => Number(all[a]?.updatedAt || 0) - Number(all[b]?.updatedAt || 0))
        .slice(0, keys.length - MAX_PROJECT_ENVIRONMENTS)
        .forEach(oldest => { delete all[oldest]; });
    }
    setStorageItem('project_environments_v1', JSON.stringify(all));
    return true;
  }

  // El origen (albalday.github.io) es compartido con otras aplicaciones: el borrado completo solo
  // toca las claves propias de ZeroChat.
  function removeOwnedStorageKeys(storage) {
    const keys = [];
    for (let i = 0; i < storage.length; i++) keys.push(storage.key(i));
    keys.filter(key => key.startsWith(STORAGE_PREFIX)).forEach(key => storage.removeItem(key));
  }

  // Errores con los que Chromium rechaza OPFS y Service Workers en file://, donde ZeroChat no los usa.
  const isUnsupportedOriginError = error => ['SecurityError', 'NotSupportedError', 'InvalidStateError'].includes(error?.name)
    || /origin .*not supported|URL protocol .*not supported/i.test(error?.message || '');

  const RESET_OPERATIONS = [
    ['localStorage', () => removeOwnedStorageKeys(localStorage)],
    ['sessionStorage', () => removeOwnedStorageKeys(sessionStorage)],
    ['Cookies', () => { if (cookiesAvailable()) writeBackendSessionCookie('', 0); }],
    ['ZeroChat IndexedDB', () => Database.deleteOriginDatabases()],
    ['Cache Storage', async () => {
      if (typeof caches === 'undefined') return;
      const results = await Promise.allSettled((await caches.keys()).map(name => caches.delete(name)));
      if (results.some(result => result.status === 'rejected')) throw new Error('Cache Storage deletion failed.');
    }],
    ['OPFS', async () => {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return;
      try {
        const root = await navigator.storage.getDirectory();
        const removals = [];
        for await (const name of root.keys()) removals.push(root.removeEntry(name, { recursive: true }));
        const results = await Promise.allSettled(removals);
        if (results.some(result => result.status === 'rejected')) throw new Error('OPFS deletion failed.');
      } catch (error) {
        if (!isUnsupportedOriginError(error)) throw error;
      }
    }],
    ['Service Workers', async () => {
      if (typeof navigator === 'undefined' || !navigator.serviceWorker?.getRegistrations) return;
      try {
        await Promise.all((await navigator.serviceWorker.getRegistrations()).map(registration => registration.unregister()));
      } catch (error) {
        if (!isUnsupportedOriginError(error)) throw error;
      }
    }]
  ];

  /** Borra todos los datos locales de ZeroChat; si algo falla, getLastClearAllStorageError() da el motivo. */
  async function clearAllStorage() {
    const results = await Promise.allSettled(RESET_OPERATIONS.map(async ([, run]) => run()));
    const failures = results
      .map((result, index) => result.status === 'rejected'
        ? `${RESET_OPERATIONS[index][0]}: ${result.reason?.message || result.reason || 'unknown error'}`
        : '')
      .filter(Boolean);
    lastClearAllStorageError = failures.join(' · ');
    if (failures.length) console.warn('[ChatStorage] Complete local-data reset failed:', lastClearAllStorageError);
    return failures.length === 0;
  }

  const getLastClearAllStorageError = () => lastClearAllStorageError;

  // ==========================================================================
  // Conversaciones y mensajes en IndexedDB
  // ==========================================================================

  /** Ejecuta una operación de IndexedDB; si falla, avisa y propaga el error estructurado. */
  async function attempt(action, operation) {
    try {
      return await operation(await Database.openDatabase());
    } catch (error) {
      console.warn(`[ChatStorage] Could not ${action}:`, error);
      const wrapped = new Error(`Could not ${action}: ${error?.message || String(error)}`, { cause: error });
      wrapped.code = 'STORAGE_ERROR';
      wrapped.action = action;
      throw wrapped;
    }
  }

  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const isBackendConnected = () => getMCP().manager.isProxyConnected();
  const requestBackend = (method, params = {}, options = {}) => getMCP().manager.requestExternalControl(method, params, options);

  const conversationRange = id => IDBKeyRange.bound([id, -Infinity], [id, Infinity]);

  // Código del error al abrir sin servidor una conversación de la que solo se tiene la cabecera.
  const CONVERSATION_NOT_DOWNLOADED = 'CONVERSATION_NOT_DOWNLOADED';

  function toConversationHeader(record) {
    const { id, title, createdAt, updatedAt, messageCount, profileId, serverRun, project, messagesPending } = record;
    return {
      id,
      title,
      createdAt,
      updatedAt,
      messageCount,
      ...(profileId ? { profileId } : {}),
      ...(serverRun !== undefined ? { serverRun } : {}),
      ...(project ? { project } : {}),
      ...(messagesPending ? { messagesPending: true } : {})
    };
  }

  /**
   * Registro de IndexedDB de una conversación con `messageCount` mensajes. `synced` marca la copia que
   * coincide con la del servidor; sin ella, la conversación se sube al conectar (getConversationsList).
   */
  function toConversationRecord(sessionMeta, messageCount, now = Date.now(), synced = false) {
    return {
      id: sessionMeta.id,
      title: sessionMeta.title || '',
      createdAt: sessionMeta.createdAt || now,
      updatedAt: sessionMeta.updatedAt || now,
      messageCount,
      ...(sessionMeta.profileId ? { profileId: sessionMeta.profileId } : {}),
      ...(sessionMeta.serverRun !== undefined ? { serverRun: Boolean(sessionMeta.serverRun) } : {}),
      ...(sessionMeta.project ? { project: sessionMeta.project } : {}),
      ...(synced ? { synced: true } : {})
    };
  }

  const blobIdsOf = messages => messages.flatMap(msg => (Array.isArray(msg?.images) ? msg.images : [])
    .map(img => img?.blobId).filter(Boolean));

  async function deleteOrphanBlobs(tx, candidates) {
    if (candidates.size === 0) return;
    const byBlobId = tx.objectStore(STORES.messages).index('by_blobId');
    const blobs = tx.objectStore(STORES.blobs);
    await Promise.all(Array.from(candidates, async blobId => {
      if ((await requestResult(byBlobId.getKey(blobId))) === undefined) blobs.delete(blobId);
    }));
  }

  function toMessageRecord(message, conversationId, position, messageId) {
    const blobIds = Array.from(new Set(blobIdsOf([message])));
    const record = {
      id: `${conversationId}:${position}`,
      messageId,
      conversationId,
      position,
      role: message.role || 'user',
      content: message.content !== undefined ? message.content : '',
      ...(blobIds.length > 0 ? { blobIds } : {})
    };
    for (const field of OPTIONAL_MESSAGE_FIELDS) if (message[field]) record[field] = message[field];
    return record;
  }

  const fromMessageRecord = ({ id, messageId, conversationId, position, blobIds, ...message }) => ({
    id: messageId || id,
    ...message
  });

  /** Registros de las conversaciones, de la más reciente a la más antigua, sin sus mensajes. */
  function readLocalConversationRecords() {
    return attempt('read the conversation list', async db => {
      const store = db.transaction(STORES.conversations, 'readonly').objectStore(STORES.conversations);
      return (await requestResult(store.index('by_updatedAt').getAll())).reverse();
    });
  }

  const readLocalConversationsList = async () => (await readLocalConversationRecords()).map(toConversationHeader);

  function readLocalConversationRecord(sessionId) {
    return attempt('read the conversation', async db => requestResult(db.transaction(STORES.conversations, 'readonly').objectStore(STORES.conversations).get(sessionId)));
  }

  async function readLocalConversation(sessionId) {
    const conversation = await attempt('read the conversation', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readonly');
      const conversation = await requestResult(tx.objectStore(STORES.conversations).get(sessionId));
      if (!conversation) return null;
      const messages = await getAllByIndex(tx.objectStore(STORES.messages), 'by_conversation', conversationRange(sessionId));
      return { ...toConversationHeader(conversation), history: messages.map(fromMessageRecord) };
    });
    // Una cabecera remota más reciente deja pendiente la copia local, pero sus mensajes siguen aquí y se abren.
    if (conversation?.messagesPending && conversation.history.length === 0) {
      const error = new Error(`Conversation ${sessionId} has not been downloaded from the server`);
      error.code = CONVERSATION_NOT_DOWNLOADED;
      throw error;
    }
    return conversation;
  }

  function writeLocalConversation(sessionMeta, messages = [], { synced = false } = {}) {
    const sessionId = sessionMeta.id;
    return attempt('save the conversation', async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages, STORES.blobs], 'readwrite');
      tx.objectStore(STORES.conversations).put(toConversationRecord(sessionMeta, messages.length, Date.now(), synced));
      const messageStore = tx.objectStore(STORES.messages);
      const existingMessages = await getAllByIndex(messageStore, 'by_conversation', conversationRange(sessionId));
      const newBlobIds = new Set(blobIdsOf(messages));
      const candidates = new Set(blobIdsOf(existingMessages).filter(blobId => !newBlobIds.has(blobId)));
      await deleteByIndex(messageStore, 'by_conversation', conversationRange(sessionId));
      const seenIds = new Set();
      messages.forEach((message, position) => {
        const messageId = message.id && !seenIds.has(message.id) ? message.id : createId(`msg_${sessionId}`);
        seenIds.add(messageId);
        messageStore.put(toMessageRecord(message, sessionId, position, messageId));
      });
      await deleteOrphanBlobs(tx, candidates);
      await transactionDone(tx);
      return true;
    });
  }

  /** Guarda en una transacción las cabeceras remotas cuyos mensajes se descargarán al abrirlas. */
  function writePendingHeaders(headers) {
    return attempt('save the conversation headers', async db => {
      const tx = db.transaction(STORES.conversations, 'readwrite');
      const store = tx.objectStore(STORES.conversations);
      const now = Date.now();
      for (const header of headers) store.put({ ...toConversationRecord(header, header.messageCount || 0, now, true), messagesPending: true });
      await transactionDone(tx);
    });
  }

  /**
   * La copia local gana a la del servidor solo con cambios sin subir y sin ser más antigua. Una ya
   * sincronizada no ha cambiado desde entonces: si difiere, la del servidor es la nueva, aunque un reloj
   * desfasado entre dispositivos diga otra cosa.
   */
  const localWins = (local, remote) => !local.synced && !local.messagesPending && (local.updatedAt || 0) >= (remote.updatedAt || 0);

  /** Marca como sincronizada la copia local si sigue siendo la que se subió (`updatedAt`). */
  function markSynced(sessionId, updatedAt) {
    return attempt('save the conversation', async db => {
      const tx = db.transaction(STORES.conversations, 'readwrite');
      const store = tx.objectStore(STORES.conversations);
      const record = await requestResult(store.get(sessionId));
      if (record && record.updatedAt === updatedAt) store.put({ ...record, synced: true });
      await transactionDone(tx);
    });
  }

  function fitMessageContentSlice(text, startOffset, makeParams, maxBytes) {
    let low = 1;
    let high = Math.min(text.length - startOffset, maxBytes);
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (rpcRequestByteSize('zerochat/conversations/save_chunk', makeParams(text.slice(startOffset, startOffset + mid))) <= maxBytes) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best === 0) throw new Error('Message metadata exceeds the maximum HTTP chunk size.');
    // Evita partir un par sustituto UTF-16 en la frontera del tramo.
    if (startOffset + best < text.length) {
      const lastCode = text.charCodeAt(startOffset + best - 1);
      if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
        if (best === 1) throw new Error('Message metadata exceeds the maximum HTTP chunk size.');
        best -= 1;
      }
    }
    return startOffset + best;
  }

  function splitOversizedMessage(uploadId, conversationId, msg, maxBytes) {
    if (typeof msg?.content !== 'string') {
      throw new Error('Single message exceeds the maximum HTTP chunk size.');
    }
    const { content, ...msgShell } = msg;
    const slices = [];
    let offset = 0;
    while (offset < content.length) {
      const partIndex = slices.length;
      const makeParams = chunkText => ({
        uploadId,
        conversationId,
        chunkIndex: 999,
        totalChunks: 999,
        messagePart: {
          partIndex,
          totalParts: 999,
          content: chunkText,
          ...(partIndex === 0 ? { message: { ...msgShell, content: '' } } : {})
        }
      });
      const end = fitMessageContentSlice(content, offset, makeParams, maxBytes);
      slices.push(content.slice(offset, end));
      offset = end;
    }
    const totalParts = slices.length;
    return slices.map((chunkText, partIndex) => ({
      messagePart: {
        partIndex,
        totalParts,
        content: chunkText,
        ...(partIndex === 0 ? { message: { ...msgShell, content: '' } } : {})
      }
    }));
  }

  function buildConversationChunks(uploadId, conversationId, messages, maxBytes) {
    const envelopeBytes = rpcRequestByteSize('zerochat/conversations/save_chunk', {
      uploadId,
      conversationId,
      chunkIndex: 999,
      totalChunks: 999,
      messages: []
    });
    const chunks = [];
    let batch = [];
    let batchBytes = envelopeBytes;

    for (const msg of messages) {
      const msgBytes = utf8ByteLength(JSON.stringify(msg));
      const nextBytes = batchBytes + msgBytes + (batch.length > 0 ? 1 : 0);
      if (nextBytes <= maxBytes) {
        batch.push(msg);
        batchBytes = nextBytes;
        continue;
      }
      if (batch.length > 0) {
        chunks.push({ messages: batch });
        batch = [];
        batchBytes = envelopeBytes;
        if (envelopeBytes + msgBytes <= maxBytes) {
          batch.push(msg);
          batchBytes = envelopeBytes + msgBytes;
          continue;
        }
      }
      chunks.push(...splitOversizedMessage(uploadId, conversationId, msg, maxBytes));
    }
    if (batch.length > 0) chunks.push({ messages: batch });
    return chunks;
  }

  /** Sube al servidor una conversación dividiéndola en tramos bajo el tope HTTP cuando es necesario. */
  async function saveRemoteConversation(requestBackend, sessionMeta, messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    const directParams = { conversation: sessionMeta, messages: list };
    if (rpcRequestByteSize('zerochat/conversations/save', directParams) <= CONVERSATION_SAVE_CHUNK_BYTES) {
      return requestBackend('zerochat/conversations/save', directParams);
    }
    const uploadId = createId('upload');
    const chunks = buildConversationChunks(uploadId, sessionMeta.id, list, CONVERSATION_SAVE_CHUNK_BYTES);
    const totalChunks = chunks.length;
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      await requestBackend('zerochat/conversations/save_chunk', {
        uploadId,
        conversationId: sessionMeta.id,
        chunkIndex,
        totalChunks,
        ...chunks[chunkIndex]
      });
    }
    return requestBackend('zerochat/conversations/save', {
      conversation: sessionMeta,
      uploadId
    });
  }

  /** Sube al servidor una conversación con sus blobs y marca sincronizada la copia local. */
  async function uploadConversation(sessionMeta, preparedMessages) {
    await syncPendingBlobs(preparedMessages);
    await saveRemoteConversation(requestBackend, sessionMeta, preparedMessages);
    await markSynced(sessionMeta.id, sessionMeta.updatedAt);
  }

  /**
   * Sube las conversaciones locales sin sincronizar. Un fallo (el servidor rechaza guardar la de una
   * ejecución en marcha) deja esa conversación sin sincronizar para el siguiente intento.
   */
  async function uploadUnsynced(records) {
    for (const record of records) {
      try {
        const { history, ...header } = await readLocalConversation(record.id);
        await uploadConversation(header, history);
      } catch (error) {
        console.warn(`[ChatStorage] Could not upload conversation ${record.id}:`, error);
      }
    }
  }

  /**
   * Cabeceras de las conversaciones, de la más reciente a la más antigua, sin sus mensajes.
   * Con el backend conectado se sincroniza en los dos sentidos y gana la copia más reciente: guarda en
   * IndexedDB las cabeceras remotas nuevas o más recientes, pendientes de descargar sus mensajes al
   * abrirlas, y sube las locales sin sincronizar (hechas sin conexión) que el servidor no tiene más recientes.
   * Los borrados no se recuerdan: una conversación borrada sin conexión vuelve a bajar del servidor.
   */
  async function getConversationsList() {
    const localRecords = await readLocalConversationRecords();
    if (!isBackendConnected()) return localRecords.map(toConversationHeader);

    const { conversations: remoteList = [] } = await requestBackend('zerochat/conversations/list');
    const localMap = new Map(localRecords.map(item => [item.id, item]));
    const remoteMap = new Map(remoteList.map(item => [item.id, item]));
    const stale = remoteList.filter(remote => {
      const local = localMap.get(remote.id);
      return !local || (local.updatedAt !== remote.updatedAt && !localWins(local, remote));
    });
    const unsynced = localRecords.filter(local => {
      const remote = remoteMap.get(local.id);
      return remote ? localWins(local, remote) : !local.synced && !local.messagesPending;
    });
    if (stale.length > 0) await writePendingHeaders(stale);
    await uploadUnsynced(unsynced);
    return stale.length > 0 ? readLocalConversationsList() : localRecords.map(toConversationHeader);
  }

  /**
   * Conversación completa con sus mensajes en orden; null si no existe. Con el backend conectado se
   * descarga y, si aquí faltaba o estaba pendiente, se guarda; sin él, una pendiente abre la copia
   * local que tenga y, si no tiene mensajes, lanza un error con el código CONVERSATION_NOT_DOWNLOADED.
   */
  async function getConversation(sessionId) {
    if (!sessionId) return null;
    const conversation = await readConversation(sessionId);
    if (conversation) await hydrateMessageImages(conversation.history);
    return conversation;
  }

  /**
   * Gana la copia más reciente: la local si tiene cambios sin subir (hechos sin conexión) y no es más
   * antigua que la del servidor; si no, la del servidor, que se guarda aquí si aquí faltaba o era otra.
   */
  async function readConversation(sessionId) {
    if (isBackendConnected()) {
      const remote = (await requestBackend('zerochat/conversations/get', { id: sessionId }))?.conversation;
      if (remote) {
        const local = await readLocalConversationRecord(sessionId);
        if (local && localWins(local, remote)) return readLocalConversation(sessionId);
        if (!local || local.messagesPending || local.updatedAt !== remote.updatedAt) {
          await writeLocalConversation(remote, remote.history || [], { synced: true });
        }
        return remote;
      }
    }
    return readLocalConversation(sessionId);
  }

  /**
   * Extrae los blobs de imágenes para guardarlos en el store blobs y deja solo referencias ligeras en messages.
   */
  async function prepareMessagesForStorage(messages) {
    if (!Array.isArray(messages)) return [];
    const prepared = [];
    for (const msg of messages) {
      if (Array.isArray(msg?.images) && msg.images.length > 0) {
        const lightweightImages = [];
        for (const img of msg.images) {
          if (!img || typeof img !== 'object') continue;
          let blobId = img.blobId;
          if (!blobId && img.dataUrl) {
            const blobRecord = await saveBlob({
              dataUrl: img.dataUrl,
              mimeType: img.mimeType,
              size: img.size
            });
            blobId = blobRecord.id;
          }
          const { dataUrl: _dropDataUrl, ...rest } = img;
          lightweightImages.push({
            ...rest,
            name: img.name || '',
            blobId: blobId || '',
            mimeType: img.mimeType || 'image/jpeg',
            size: typeof img.size === 'number' ? img.size : (img.dataUrl ? img.dataUrl.length : 0)
          });
        }
        prepared.push({ ...msg, images: lightweightImages });
      } else {
        prepared.push(msg);
      }
    }
    return prepared;
  }

  /** Hidrata las imágenes de los mensajes recuperando su dataUrl desde el store de blobs o el backend. */
  async function hydrateMessageImages(messages) {
    if (!Array.isArray(messages)) return messages;
    for (const msg of messages) {
      if (Array.isArray(msg?.images)) {
        for (const img of msg.images) {
          if (img?.blobId && !img.dataUrl) {
            let blob = await getBlob(img.blobId);
            if (!blob && isBackendConnected()) {
              try {
                const res = await requestBackend('zerochat/blobs/get', { id: img.blobId });
                if (res?.blob?.data) {
                  ensureBlobSyncCache();
                  syncedBlobIds.add(img.blobId);
                  blob = await saveBlob({
                    id: res.blob.id,
                    mimeType: res.blob.mimeType,
                    size: res.blob.size,
                    dataUrl: `data:${res.blob.mimeType};base64,${res.blob.data}`
                  });
                }
              } catch (error) {
                // Si el servidor falla o no tiene el blob, se continúa sin interrumpir la carga del mensaje.
                console.warn('[ChatStorage] Could not fetch remote blob:', error);
              }
            }
            if (blob?.dataUrl) {
              img.dataUrl = blob.dataUrl;
            }
          }
        }
      }
    }
    return messages;
  }

  /** Sube al backend los blobs pendientes antes de guardar la conversación. */
  async function syncPendingBlobs(messages) {
    const blobIds = [];
    for (const msg of messages) {
      if (Array.isArray(msg?.images)) {
        for (const img of msg.images) {
          if (img?.blobId) blobIds.push(img.blobId);
        }
      }
    }
    if (blobIds.length === 0) return;
    ensureBlobSyncCache();
    const uniqueIds = Array.from(new Set(blobIds)).filter(id => !syncedBlobIds.has(id));
    if (uniqueIds.length === 0) return;
    const { missing = [] } = await requestBackend('zerochat/blobs/has', { ids: uniqueIds });
    const missingSet = new Set(missing);
    for (const id of uniqueIds) {
      if (!missingSet.has(id)) syncedBlobIds.add(id);
    }
    for (const blobId of missing) {
      const blob = await getBlob(blobId);
      if (blob?.dataUrl) {
        await requestBackend('zerochat/blobs/put', {
          id: blob.id,
          mimeType: blob.mimeType,
          data: blob.dataUrl
        }, { headers: { 'X-ZeroChat-Blob': '1' } });
        syncedBlobIds.add(blobId);
      }
    }
  }

  /**
   * Guarda una conversación y sustituye todos sus mensajes; conectado, también en el servidor, con la misma
   * fecha. Sin conexión queda sin sincronizar y se sube al conectar.
   */
  async function saveConversation(sessionMeta, messages = []) {
    if (!sessionMeta?.id) return false;
    const meta = { ...sessionMeta, updatedAt: sessionMeta.updatedAt || Date.now() };
    const preparedMessages = await prepareMessagesForStorage(messages);
    await writeLocalConversation(meta, preparedMessages);
    if (isBackendConnected()) await uploadConversation(meta, preparedMessages);
    return true;
  }

  /**
   * Borra las conversaciones `ids` de IndexedDB (todas si es null) con sus mensajes y los blobs que solo
   * ellas usaban. Con el backend conectado, primero borra en el servidor las que selecciona `params` de
   * zerochat/conversations/delete: si lo rechaza, la copia local se conserva.
   */
  async function removeConversations(action, ids, params) {
    if (isBackendConnected()) await requestBackend('zerochat/conversations/delete', params);
    await attempt(action, async db => {
      const tx = db.transaction([STORES.conversations, STORES.messages, STORES.blobs], 'readwrite');
      const conversations = tx.objectStore(STORES.conversations);
      const messages = tx.objectStore(STORES.messages);
      const candidates = new Set();
      if (ids === null) {
        blobIdsOf(await requestResult(messages.getAll())).forEach(blobId => candidates.add(blobId));
        conversations.clear();
        messages.clear();
      }
      for (const id of ids || []) {
        blobIdsOf(await getAllByIndex(messages, 'by_conversation', conversationRange(id))).forEach(blobId => candidates.add(blobId));
        conversations.delete(id);
        await deleteByIndex(messages, 'by_conversation', conversationRange(id));
      }
      await deleteOrphanBlobs(tx, candidates);
      await transactionDone(tx);
    });
  }

  async function deleteConversation(sessionId) {
    if (sessionId) await removeConversations('delete the conversation', [sessionId], { id: sessionId });
  }

  const deleteAllConversations = () => removeConversations('delete the conversations', null, { all: true });

  async function deleteProjectConversations(project) {
    const target = typeof project === 'string' ? project.trim() : '';
    const ids = (await readLocalConversationsList()).filter(item => (item.project || '') === target).map(item => item.id);
    await removeConversations('delete the project conversations', ids, { project: target });
  }

  async function renameConversation(sessionId, newTitle) {
    if (!sessionId || !newTitle) return false;
    const title = newTitle.trim();
    const remoteResult = isBackendConnected()
      ? await requestBackend('zerochat/conversations/rename', { id: sessionId, title })
      : null;
    const updatedAt = Number(remoteResult?.updatedAt) || Date.now();
    return attempt('rename the conversation', async db => {
      const tx = db.transaction(STORES.conversations, 'readwrite');
      const store = tx.objectStore(STORES.conversations);
      const conversation = await requestResult(store.get(sessionId));
      // Renombrada sin conexión, se sube al conectar; conectada, conserva la fecha exacta de SQLite.
      const { synced: _synced, ...record } = conversation || {};
      if (conversation) store.put({ ...record, title, updatedAt, ...(remoteResult && conversation.synced ? { synced: true } : {}) });
      await transactionDone(tx);
      return Boolean(conversation);
    });
  }

  function dataUrlToBytes(dataUrl) {
    const commaIdx = dataUrl.indexOf(',');
    const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function computeBlobId(bytes) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Guarda un blob en IndexedDB indexado por su hash SHA-256 (deduplicado automáticamente).
   * Admite { dataUrl, mimeType, size?, id? } o { bytes, mimeType, size?, id? }.
   */
  async function saveBlob(blob) {
    if (!blob || typeof blob !== 'object') throw new Error('Blob data is required');
    let bytes = blob.bytes;
    let dataUrl = blob.dataUrl;
    let mimeType = blob.mimeType || 'application/octet-stream';

    if (!bytes && dataUrl) {
      bytes = dataUrlToBytes(dataUrl);
      if (!blob.mimeType && dataUrl.startsWith('data:')) {
        const scIdx = dataUrl.indexOf(';');
        if (scIdx > 5) mimeType = dataUrl.slice(5, scIdx);
      }
    } else if (bytes && !dataUrl) {
      dataUrl = `data:${mimeType};base64,${Utils.bytesToBase64(bytes)}`;
    }

    if (!bytes || bytes.length === 0) throw new Error('Blob data cannot be empty');

    const id = (blob.id || (await computeBlobId(bytes))).trim().toLowerCase();
    const size = typeof blob.size === 'number' ? blob.size : bytes.length;
    const now = Date.now();
    const record = {
      id,
      mimeType,
      size,
      dataUrl,
      createdAt: blob.createdAt || now
    };

    await attempt('save blob', async db => {
      const tx = db.transaction(STORES.blobs, 'readwrite');
      tx.objectStore(STORES.blobs).put(record);
      await transactionDone(tx);
    });

    return record;
  }

  /** Recupera un blob de IndexedDB por su id (hash SHA-256). */
  async function getBlob(id) {
    if (!id || typeof id !== 'string') return null;
    return attempt('get blob', async db => {
      const tx = db.transaction(STORES.blobs, 'readonly');
      const record = await requestResult(tx.objectStore(STORES.blobs).get(id.trim().toLowerCase()));
      return record || null;
    });
  }

  const SEARCH_SYNC_CONCURRENCY = 4;

  function messageText(record) {
    if (typeof record?.content === 'string') return record.content;
    if (!Array.isArray(record?.content)) return '';
    return record.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }

  /** Descarga las conversaciones pendientes (`messagesPending`) para que la búsqueda incluya las de otros dispositivos o CLI. */
  async function syncPendingConversations(onProgress = null) {
    if (!isBackendConnected()) return;
    const pending = (await readLocalConversationRecords()).filter(record => record.messagesPending);
    if (pending.length === 0) return;
    let done = 0;
    onProgress?.({ phase: 'syncing', done, total: pending.length });
    for (let i = 0; i < pending.length; i += SEARCH_SYNC_CONCURRENCY) {
      await Promise.all(pending.slice(i, i + SEARCH_SYNC_CONCURRENCY).map(async record => {
        try {
          await readConversation(record.id);
        } catch (error) {
          console.warn(`[ChatStorage] Could not sync conversation ${record.id} for search:`, error);
        } finally {
          done += 1;
        }
      }));
      onProgress?.({ phase: 'syncing', done, total: pending.length });
    }
  }

  /**
   * IDs de conversaciones cuyo título o contenido de mensajes coincide con `query`.
   * Si el backend está conectado, descarga primero las conversaciones pendientes de mensajes.
   */
  async function searchConversations(query, { syncPending = true, onProgress = null } = {}) {
    const needle = String(query || '').toLowerCase().trim();
    if (!needle) return new Set();
    if (syncPending) await syncPendingConversations(onProgress);
    onProgress?.({ phase: 'searching' });
    return attempt('search conversations', db => new Promise((resolve, reject) => {
      const tx = db.transaction([STORES.conversations, STORES.messages], 'readonly');
      const matches = new Set();
      tx.objectStore(STORES.conversations).getAll().onsuccess = event => {
        for (const conv of event.target.result || []) {
          if (conv.title?.toLowerCase().includes(needle)) matches.add(conv.id);
        }
      };
      tx.objectStore(STORES.messages).openCursor().onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;
        const record = cursor.value;
        if (record?.conversationId && !matches.has(record.conversationId) && messageText(record).toLowerCase().includes(needle)) {
          matches.add(record.conversationId);
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(matches);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  return {
    setStorageItem,
    getStorageItem,
    deleteStorageItem,
    normalizeBackendSession,
    setBackendSession,
    getBackendSession,
    loadRuntimeConfigV2,
    saveRuntimeConfigV2,
    loadProjectEnvironments,
    saveProjectEnvironment,
    clearAllStorage,
    getLastClearAllStorageError,
    getConversationsList,
    getConversation,
    searchConversations,
    saveConversation,
    saveRemoteConversation,
    CONVERSATION_SAVE_CHUNK_BYTES,
    deleteConversation,
    deleteAllConversations,
    deleteProjectConversations,
    CONVERSATION_NOT_DOWNLOADED,
    renameConversation,
    saveBlob,
    getBlob
  };
});
