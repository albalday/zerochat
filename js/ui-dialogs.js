(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatDialogs = factory(root.ChatState, root.ChatI18n, root.document);
})(typeof self !== 'undefined' ? self : this, function (state, i18n, document) {
  'use strict';

  function create(store, translations, doc) {
    const dialog = doc.getElementById('notice-dialog');
    const title = doc.getElementById('notice-title');
    const message = doc.getElementById('notice-message');
    const accept = doc.getElementById('notice-accept');
    const cancel = doc.getElementById('notice-cancel');
    const input = doc.getElementById('notice-input');
    let activeId = null;
    let previousFocus = null;

    function render() {
      const notice = (store.get('ui').notices || [])[0];
      if (notice?.id === activeId) return;
      activeId = notice?.id || null;
      if (!notice) {
        input.value = '';
        if (dialog.open) dialog.close();
        if (previousFocus?.isConnected) previousFocus.focus();
        previousFocus = null;
        return;
      }
      title.textContent = notice.title;
      message.textContent = notice.message;
      accept.textContent = translations.t('notice_accept');
      cancel.textContent = translations.t('notice_cancel');
      cancel.hidden = notice.mode === 'alert';
      input.hidden = notice.mode !== 'prompt';
      input.value = notice.mode === 'prompt' ? notice.value : '';
      dialog.dataset.type = notice.type;
      if (!dialog.open) {
        previousFocus = doc.activeElement;
        dialog.showModal();
      }
      (notice.mode === 'prompt' ? input : notice.mode === 'confirm' ? cancel : accept).focus();
      if (notice.mode === 'prompt') input.select();
    }
    function dismiss(accepted = false) {
      if (activeId !== null) store.dismissNotice(activeId, accepted, input.value);
    }
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        dismiss(true);
      }
    });
    accept.addEventListener('click', () => dismiss(true));
    cancel.addEventListener('click', () => dismiss(false));
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('close', () => { if (!dialog.open) dismiss(); });
    store.subscribe(s => JSON.stringify(s.ui.notices || []), render);
    render();

    function enqueue(message, options, mode, value) {
      const type = options.type || 'info';
      const id = store.enqueueNotice({ message: String(message ?? ''), title: String(options.title ?? translations.t(mode === 'prompt' ? 'notice_prompt' : mode === 'confirm' ? 'notice_confirm' : 'notice_' + type)), type, mode, value });
      return new Promise(resolve => {
        const unsubscribe = store.subscribe(s => (s.ui.notices || []).some(item => item.id === id), present => {
          if (!present) {
            unsubscribe();
            const result = store.get('ui').noticeResult;
            const accepted = result?.id === id && result.accepted === true;
            resolve(mode === 'prompt' ? (accepted ? result.value : null) : mode === 'confirm' ? accepted : undefined);
          }
        });
      });
    }
    return {
      alert: (message, options = {}) => enqueue(message, options, 'alert'),
      confirm: (message, options = {}) => enqueue(message, options, 'confirm'),
      prompt: (message, defaultValue = '', options = {}) => enqueue(message, options, 'prompt', defaultValue)
    };
  }
  return document ? create(state, i18n, document) : { create };
});
