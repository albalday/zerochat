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
    const checkboxContainer = doc.getElementById('notice-checkbox-container');
    const checkbox = doc.getElementById('notice-checkbox');
    const checkboxText = doc.getElementById('notice-checkbox-text');
    let activeId = null;
    let previousFocus = null;

    function render() {
      const notice = (store.get('ui').notices || [])[0];
      if (notice?.id === activeId) return;
      activeId = notice?.id || null;
      if (!notice) {
        input.value = '';
        if (checkbox) checkbox.checked = false;
        if (checkboxContainer) checkboxContainer.hidden = true;
        accept.setAttribute('data-i18n', 'notice_accept');
        accept.textContent = translations.t('notice_accept');
        cancel.setAttribute('data-i18n', 'notice_cancel');
        cancel.textContent = translations.t('notice_cancel');
        if (dialog.open) dialog.close();
        if (previousFocus?.isConnected) previousFocus.focus();
        previousFocus = null;
        return;
      }
      title.textContent = notice.title;
      message.textContent = notice.message;
      if (notice.acceptText) {
        accept.removeAttribute('data-i18n');
        accept.textContent = notice.acceptText;
      } else {
        accept.setAttribute('data-i18n', 'notice_accept');
        accept.textContent = translations.t('notice_accept');
      }
      if (notice.cancelText) {
        cancel.removeAttribute('data-i18n');
        cancel.textContent = notice.cancelText;
      } else {
        cancel.setAttribute('data-i18n', 'notice_cancel');
        cancel.textContent = translations.t('notice_cancel');
      }
      cancel.hidden = notice.mode === 'alert';
      input.hidden = notice.mode !== 'prompt';
      input.type = notice.inputType === 'password' ? 'password' : 'text';
      input.value = notice.mode === 'prompt' ? notice.value : '';
      if (checkboxContainer) {
        checkboxContainer.hidden = !notice.checkbox;
        if (checkboxText) checkboxText.textContent = notice.checkbox || '';
        if (checkbox) checkbox.checked = Boolean(notice.checkboxDefault);
      }
      dialog.dataset.type = notice.type;
      if (!dialog.open) {
        previousFocus = doc.activeElement;
        dialog.showModal();
      }
      (notice.mode === 'prompt' ? input : notice.mode === 'confirm' ? cancel : accept).focus();
      if (notice.mode === 'prompt') input.select();
    }
    function dismiss(accepted = false) {
      if (activeId !== null) {
        const isChecked = Boolean(checkbox && checkbox.checked);
        store.dismissNotice(activeId, accepted, input.value, isChecked);
      }
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
      const id = store.enqueueNotice({
        message: String(message ?? ''),
        title: String(options.title ?? translations.t(mode === 'prompt' ? 'notice_prompt' : mode === 'confirm' ? 'notice_confirm' : 'notice_' + type)),
        type,
        mode,
        value,
        acceptText: options.acceptText,
        cancelText: options.cancelText,
        checkbox: options.checkbox,
        checkboxDefault: options.checkboxDefault,
        inputType: options.inputType
      });
      return new Promise(resolve => {
        const unsubscribe = store.subscribe(s => (s.ui.notices || []).some(item => item.id === id), present => {
          if (!present) {
            unsubscribe();
            const result = store.get('ui').noticeResult;
            const accepted = result?.id === id && result.accepted === true;
            const checkboxChecked = Boolean(result?.id === id && result.checkboxChecked === true);
            if (options.checkbox !== undefined || options.returnDetails) {
              resolve({ accepted, applyToAll: checkboxChecked, checkboxChecked, value: result?.value ?? null });
            } else {
              resolve(mode === 'prompt' ? (accepted ? result.value : null) : mode === 'confirm' ? accepted : undefined);
            }
          }
        });
      });
    }
    return {
      alert: (message, options = {}) => enqueue(message, options, 'alert'),
      confirm: (message, options = {}) => enqueue(message, options, 'confirm'),
      prompt: (message, defaultValue = '', options = {}) => enqueue(message, options, 'prompt', defaultValue),
      askDuplicate: (message, options = {}) => enqueue(message, {
        ...options,
        type: options.type || 'info',
        acceptText: options.acceptText || translations.t('rag_btn_replace'),
        cancelText: options.cancelText || translations.t('rag_btn_ignore'),
        checkbox: options.checkbox || translations.t('rag_duplicate_apply_all')
      }, 'confirm')
    };
  }
  return document ? create(state, i18n, document) : { create };
});
