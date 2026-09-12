function copyText(text, btn) {
  if (!navigator.clipboard) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      markCopied(btn);
    } catch (_) {}
    document.body.removeChild(ta);
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    markCopied(btn);
  }).catch(err => {
    console.error('Error al copiar texto:', err);
  });
}

function markCopied(btn) {
  if (!btn) return;
  const originalText = btn.textContent;
  btn.textContent = '¡Copiado!';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = originalText;
    btn.classList.remove('copied');
  }, 1800);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.code-wrapper').forEach(wrapper => {
    if (wrapper.querySelector('.btn-copy')) return;
    const pre = wrapper.querySelector('pre');
    if (!pre) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-copy';
    btn.textContent = 'Copiar';
    btn.addEventListener('click', () => {
      copyText(pre.textContent.trim(), btn);
    });
    wrapper.appendChild(btn);
  });
});

