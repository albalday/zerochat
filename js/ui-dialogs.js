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
    let activeId = null;
    let previousFocus = null;

    function render() {
      const notice = (store.get('ui').notices || [])[0];
      if (notice?.id === activeId) return;
      activeId = notice?.id || null;
      if (!notice) {
        if (dialog.open) dialog.close();
        if (previousFocus?.isConnected) previousFocus.focus();
        previousFocus = null;
        return;
      }
      title.textContent = notice.title;
      message.textContent = notice.message;
      accept.textContent = translations.t('notice_accept');
      dialog.dataset.type = notice.type;
      if (!dialog.open) {
        previousFocus = doc.activeElement;
        dialog.showModal();
      }
      accept.focus();
    }
    function dismiss() {
      if (activeId !== null) store.dismissNotice(activeId);
    }
    accept.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('close', () => { if (!dialog.open) dismiss(); });
    store.subscribe(s => JSON.stringify(s.ui.notices || []), render);
    render();

    function alert(message, options = {}) {
      const type = options.type || 'info';
      const id = store.enqueueNotice({ message: String(message ?? ''), title: String(options.title ?? translations.t('notice_' + type)), type });
      return new Promise(resolve => {
        const unsubscribe = store.subscribe(s => (s.ui.notices || []).some(item => item.id === id), present => {
          if (!present) { unsubscribe(); resolve(); }
        });
      });
    }
    return { alert };
  }
  return document ? create(state, i18n, document) : { create };
});
