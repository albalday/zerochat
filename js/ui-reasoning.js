/**
 * Módulo de Interfaz de Usuario para Selección de Razonamiento (Thinking / CoT).
 * ZeroChat - js/ui-reasoning.js
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUIReasoning = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof require !== 'undefined') { try { return require(relPath); } catch (e) { return null; } }
    return null;
  }

  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getApi = () => resolveDep('ChatAPI', './api.js');

  function t(key, params) {
    const I18n = getI18n();
    if (I18n && typeof I18n.t === 'function') return I18n.t(key, params);
    return key;
  }

  function getReasoningLevelLabel(lvl) {
    const lower = String(lvl).toLowerCase().trim();
    switch (lower) {
      case 'off':
      case 'none':
        return { icon: '⚪', label: t('reasoning_level_none'), desc: t('reasoning_desc_none') };
      case 'on':
        return { icon: '🧠', label: t('reasoning_level_on'), desc: t('reasoning_desc_on') };
      case 'minimal':
        return { icon: '🟢', label: t('reasoning_level_minimal'), desc: t('reasoning_desc_minimal') };
      case 'low':
        return { icon: '🟢', label: t('reasoning_level_low'), desc: t('reasoning_desc_low') };
      case 'medium':
        return { icon: '🟡', label: t('reasoning_level_medium'), desc: t('reasoning_desc_medium') };
      case 'high':
        return { icon: '🔴', label: t('reasoning_level_high'), desc: t('reasoning_desc_high') };
      case 'xhigh':
        return { icon: '🔥', label: t('reasoning_level_xhigh'), desc: t('reasoning_desc_xhigh') };
      default:
        return { icon: '⚙️', label: lvl.charAt(0).toUpperCase() + lvl.slice(1), desc: '' };
    }
  }

  function renderReasoningMenuOptions(elements, reasoningInfo, activeLevel, onSelect) {
    if (!elements || !elements.reasoningOptionsContainer) return;

    elements.reasoningOptionsContainer.innerHTML = '';
    const levels = (reasoningInfo && Array.isArray(reasoningInfo.levels)) ? reasoningInfo.levels : ['off', 'low', 'medium', 'high'];

    levels.forEach(lvl => {
      const doc = elements.reasoningOptionsContainer.ownerDocument || document;
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'reasoning-option';
      btn.setAttribute('data-level', lvl);
      if (typeof btn.setAttribute === 'function') {
        btn.setAttribute('role', 'menuitemradio');
      }

      const info = getReasoningLevelLabel(lvl);
      const lower = String(lvl).toLowerCase().trim();
      const activeLower = String(activeLevel || 'off').toLowerCase().trim();
      const isSelected = lower === activeLower || (activeLower === 'off' && lower === 'none') || (activeLower === 'none' && lower === 'off');

      if (isSelected) {
        btn.classList.add('active');
        if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-checked', 'true');
      } else {
        if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-checked', 'false');
      }

      btn.innerHTML = `
        <span class="option-icon" aria-hidden="true">${info.icon}</span>
        <div class="option-text">
          <strong class="option-title">${info.label}</strong>
          ${info.desc ? `<small class="option-desc">${info.desc}</small>` : ''}
        </div>
        <span class="option-check" aria-hidden="true">
          <svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </span>
      `;

      btn.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') {
          e.stopPropagation();
        }
        if (typeof onSelect === 'function') {
          onSelect(lvl);
        }
      });

      elements.reasoningOptionsContainer.appendChild(btn);
    });
  }

  function initReasoningKeyboardNav(elements) {
    if (!elements || !elements.reasoningMenu || typeof elements.reasoningMenu.addEventListener !== 'function' || elements.reasoningMenu._hasKeyNav) return;
    elements.reasoningMenu._hasKeyNav = true;

    elements.reasoningMenu.addEventListener('keydown', (e) => {
      if (!elements.reasoningOptionsContainer) return;
      const options = Array.from(elements.reasoningOptionsContainer.querySelectorAll ? elements.reasoningOptionsContainer.querySelectorAll('.reasoning-option') : []);
      if (!options.length) return;

      const activeEl = elements.reasoningMenu.ownerDocument ? elements.reasoningMenu.ownerDocument.activeElement : document.activeElement;
      const currentIndex = options.findIndex(opt => opt === activeEl);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = currentIndex < options.length - 1 ? currentIndex + 1 : 0;
        if (options[nextIndex] && typeof options[nextIndex].focus === 'function') {
          options[nextIndex].focus();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
        if (options[prevIndex] && typeof options[prevIndex].focus === 'function') {
          options[prevIndex].focus();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeReasoningMenu(elements);
        if (elements.btnReasoning && typeof elements.btnReasoning.focus === 'function') {
          elements.btnReasoning.focus();
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (options[0] && typeof options[0].focus === 'function') {
          options[0].focus();
        }
      } else if (e.key === 'End') {
        e.preventDefault();
        if (options[options.length - 1] && typeof options[options.length - 1].focus === 'function') {
          options[options.length - 1].focus();
        }
      }
    });
  }

  function positionReasoningMenu(elements) {
    if (!elements || !elements.reasoningMenu || !elements.btnReasoning) return;
    if (elements.reasoningMenu.style.display === 'none') return;

    const btnRect = elements.btnReasoning.getBoundingClientRect ? elements.btnReasoning.getBoundingClientRect() : { top: 0, left: 0 };
    const win = elements.reasoningMenu.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!win) return;
    const viewportHeight = win.visualViewport ? win.visualViewport.height : (win.innerHeight || 800);
    const viewportWidth = win.innerWidth || 1200;

    const spaceAbove = btnRect.top;
    const menuWidth = Math.min(290, viewportWidth - 16);

    let leftPos = btnRect.left;
    if (leftPos + menuWidth > viewportWidth - 8) {
      leftPos = viewportWidth - menuWidth - 8;
    }
    if (leftPos < 8) {
      leftPos = 8;
    }

    elements.reasoningMenu.style.position = 'fixed';
    elements.reasoningMenu.style.left = `${Math.round(leftPos)}px`;
    elements.reasoningMenu.style.width = `${Math.round(menuWidth)}px`;

    const bottomPos = Math.max(8, viewportHeight - btnRect.top + 8);
    const maxHeight = Math.max(140, Math.min(380, spaceAbove - 16));

    elements.reasoningMenu.style.bottom = `${Math.round(bottomPos)}px`;
    elements.reasoningMenu.style.top = 'auto';
    elements.reasoningMenu.style.maxHeight = `${Math.round(maxHeight)}px`;
  }

  function openReasoningMenu(elements, appConfig, onSelect, onToggleCheckpoint) {
    if (!elements || !elements.reasoningMenu) return;
    elements.reasoningMenu.style.display = 'flex';

    if (elements.btnReasoning && typeof elements.btnReasoning.setAttribute === 'function') {
      elements.btnReasoning.setAttribute('aria-expanded', 'true');
    }

    const API = getApi();
    const apiType = appConfig?.apiType || (elements.settingApiType ? elements.settingApiType.value : 'openai');
    const reasoningConfig = API?.getStandardReasoningOptions
      ? API.getStandardReasoningOptions(apiType, appConfig?.apiUrl)
      : { levels: ['off', 'low', 'medium', 'high'], label: 'OpenAI / LM Studio' };

    if (elements.reasoningModelBadge) {
      elements.reasoningModelBadge.textContent = reasoningConfig.label || apiType.toUpperCase();
      elements.reasoningModelBadge.title = `Protocol: ${reasoningConfig.label || apiType}`;
    }

    renderReasoningMenuOptions(elements, reasoningConfig, appConfig?.reasoningEffort || 'off', onSelect);
    syncCheckpointToggle(elements, Boolean(appConfig?.enabledTools?.agent_checkpoint), onToggleCheckpoint);
    positionReasoningMenu(elements);
    initReasoningKeyboardNav(elements);

    // Focus active or first option for keyboard accessibility
    if (elements.reasoningOptionsContainer && typeof elements.reasoningOptionsContainer.querySelector === 'function') {
      const activeBtn = elements.reasoningOptionsContainer.querySelector('.reasoning-option.active') ||
                        elements.reasoningOptionsContainer.querySelector('.reasoning-option');
      if (activeBtn && typeof activeBtn.focus === 'function') {
        activeBtn.focus();
      }
    }
  }

  function syncCheckpointToggle(elements, isEnabled, onToggleCheckpoint) {
    if (!elements) return;
    const chk = elements.chkReasoningAgentCheckpoint ||
      (elements.reasoningMenu?.querySelector ? elements.reasoningMenu.querySelector('#chk-reasoning-agent-checkpoint') : null);
    if (!chk) return;

    chk.checked = Boolean(isEnabled);

    if (!chk._hasAgentListener && typeof onToggleCheckpoint === 'function') {
      chk._hasAgentListener = true;
      chk.addEventListener('change', (e) => {
        onToggleCheckpoint(e.target.checked);
      });
    }
  }

  function closeReasoningMenu(elements) {
    if (!elements || !elements.reasoningMenu) return;
    elements.reasoningMenu.style.display = 'none';
    elements.reasoningMenu.style.left = '0px';
    elements.reasoningMenu.style.right = 'auto';

    if (elements.btnReasoning && typeof elements.btnReasoning.setAttribute === 'function') {
      elements.btnReasoning.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleReasoningMenu(elements, appConfig, onSelect, onToggleCheckpoint) {
    if (!elements || !elements.reasoningMenu) return;
    const isVisible = elements.reasoningMenu.style.display === 'flex' || elements.reasoningMenu.style.display === 'block';
    if (isVisible) {
      closeReasoningMenu(elements);
    } else {
      openReasoningMenu(elements, appConfig, onSelect, onToggleCheckpoint);
    }
  }

  function selectReasoningLevel(elements, appConfig, level, onLevelChanged) {
    let norm = String(level).trim();
    if (norm.toLowerCase() === 'off') norm = 'none';
    updateReasoningUI(elements, norm);
    closeReasoningMenu(elements);
    if (typeof onLevelChanged === 'function') {
      onLevelChanged(norm);
    }
  }

  function updateReasoningUI(elements, level) {
    if (!elements) return;
    const val = level || 'none';
    const lower = String(val).toLowerCase().trim();

    if (elements.reasoningLabel && elements.btnReasoning) {
      if (lower === 'off' || lower === 'none') {
        elements.reasoningLabel.textContent = 'None';
        elements.btnReasoning.classList.remove('active', 'active-on', 'active-low', 'active-medium', 'active-high', 'active-xhigh', 'level-low', 'level-medium', 'level-high', 'level-xhigh');
      } else {
        let displayTxt = lower.charAt(0).toUpperCase() + lower.slice(1);
        if (lower === 'low') displayTxt = 'Low';
        else if (lower === 'medium') displayTxt = 'Med';
        else if (lower === 'high') displayTxt = 'High';
        else if (lower === 'xhigh') displayTxt = 'XHigh';
        else if (lower === 'on') displayTxt = 'On';

        elements.reasoningLabel.textContent = displayTxt;
        elements.btnReasoning.classList.add('active');
        elements.btnReasoning.classList.remove('active-on', 'active-low', 'active-medium', 'active-high', 'active-xhigh', 'level-low', 'level-medium', 'level-high', 'level-xhigh');
        if (['low', 'medium', 'high', 'xhigh', 'on'].includes(lower)) {
          elements.btnReasoning.classList.add(`active-${lower}`);
        }
      }
    }

    if (elements.reasoningOptionsContainer && typeof elements.reasoningOptionsContainer.querySelectorAll === 'function') {
      const options = elements.reasoningOptionsContainer.querySelectorAll('.reasoning-option');
      if (options && options.forEach) {
        options.forEach(opt => {
          const optLower = String(opt.getAttribute ? opt.getAttribute('data-level') : '').toLowerCase().trim();
          const isSelected = optLower === lower || (lower === 'off' && optLower === 'none') || (lower === 'none' && optLower === 'off');
          if (isSelected) {
            if (opt.classList && typeof opt.classList.add === 'function') opt.classList.add('active');
            if (typeof opt.setAttribute === 'function') opt.setAttribute('aria-checked', 'true');
          } else {
            if (opt.classList && typeof opt.classList.remove === 'function') opt.classList.remove('active');
            if (typeof opt.setAttribute === 'function') opt.setAttribute('aria-checked', 'false');
          }
        });
      }
    }
  }

  return {
    getReasoningLevelLabel,
    renderReasoningMenuOptions,
    positionReasoningMenu,
    openReasoningMenu,
    closeReasoningMenu,
    toggleReasoningMenu,
    selectReasoningLevel,
    updateReasoningUI,
    syncCheckpointToggle
  };
});
