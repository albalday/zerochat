/**
 * Documento HTML para leer páginas web y el HTML que genera mammoth (ChatHtmlDocument).
 *
 * En el navegador `parseHtml` usa su DOMParser. En el runner desatendido de Node.js (js/run-node.js) no
 * hay DOMParser: construye un árbol ligero que ofrece el subconjunto del DOM que usan sus consumidores
 * (`ChatWebBrowser.extractReadableTextFromHtml` y el paso de docx a Markdown de `ChatOfficeParser`):
 * nodos de elemento y de texto, `childNodes`, `children`, `getAttribute`, `textContent`/`innerText`,
 * `querySelector(All)` con selectores simples (etiqueta, #id, .clase, [atributo="valor"] y listas
 * separadas por comas), `remove`, `replaceWith`, `appendChild`, `cloneNode` y `createElement`/`createTextNode`.
 * El análisis es tolerante como el de un navegador: ignora cierres sin apertura, cierra implícitamente
 * párrafos, elementos de lista y celdas, y trata `script` y `style` como texto sin marcado.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatHtmlDocument = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  // Contenido sin marcado: hasta su etiqueta de cierre. `title` y `textarea` decodifican entidades.
  const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);
  const ESCAPABLE_RAW_TEXT_ELEMENTS = new Set(['title', 'textarea']);
  // Elementos que van en <head> mientras no haya empezado el cuerpo.
  const HEAD_ELEMENTS = new Set(['base', 'link', 'meta', 'script', 'style', 'title']);
  const CLOSES_PARAGRAPH = new Set([
    'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul'
  ]);
  // Etiqueta que se abre -> etiquetas abiertas que cierra implícitamente, sin salir de su contenedor.
  const IMPLIED_END = {
    li: { closes: ['li'], scope: ['ul', 'ol'] },
    dt: { closes: ['dt', 'dd'], scope: ['dl'] },
    dd: { closes: ['dt', 'dd'], scope: ['dl'] },
    tr: { closes: ['tr', 'td', 'th'], scope: ['table', 'tbody', 'thead', 'tfoot'] },
    td: { closes: ['td', 'th'], scope: ['tr', 'table'] },
    th: { closes: ['td', 'th'], scope: ['tr', 'table'] },
    tbody: { closes: ['tbody', 'thead', 'tfoot', 'tr', 'td', 'th'], scope: ['table'] },
    thead: { closes: ['tbody', 'thead', 'tfoot', 'tr', 'td', 'th'], scope: ['table'] },
    tfoot: { closes: ['tbody', 'thead', 'tfoot', 'tr', 'td', 'th'], scope: ['table'] },
    option: { closes: ['option'], scope: ['select', 'datalist'] }
  };
  const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
    hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab',
    raquo: '\u00bb', bull: '\u2022', middot: '\u00b7', deg: '\u00b0', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', times: '\u00d7',
    divide: '\u00f7', sect: '\u00a7', para: '\u00b6', iexcl: '\u00a1', iquest: '\u00bf', aacute: '\u00e1', eacute: '\u00e9', iacute: '\u00ed',
    oacute: '\u00f3', uacute: '\u00fa', ntilde: '\u00f1', uuml: '\u00fc', Aacute: '\u00c1', Eacute: '\u00c9', Iacute: '\u00cd', Oacute: '\u00d3',
    Uacute: '\u00da', Ntilde: '\u00d1', Uuml: '\u00dc', ccedil: '\u00e7', Ccedil: '\u00c7'
  };

  function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (entity, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : entity;
    });
  }

  function parseAttributes(source) {
    const attributes = new Map();
    const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const [, name, double, single, bare] of source.matchAll(pattern)) {
      const key = name.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, decodeEntities(double ?? single ?? bare ?? ''));
    }
    return attributes;
  }

  // --- Selectores simples ------------------------------------------------------

  /** Lista de selectores compuestos: `tag#id.clase[attr="v"]`, separados por comas. */
  function compileSelector(selector) {
    return selector.split(',').map(part => {
      const source = part.trim();
      const pattern = /^([a-z][a-z0-9-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*"|='[^']*'|=[\w-]+)?\])*)$/i;
      const match = source.match(pattern);
      if (!source || !match) throw new Error(`Unsupported selector: ${selector}`);
      const tag = match[1] && match[1] !== '*' ? match[1].toLowerCase() : '';
      const checks = [...match[2].matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/g)]
        .map(([, id, className, attr, double, single, bare]) => {
          if (id) return element => element.getAttribute('id') === id;
          if (className) return element => (element.getAttribute('class') || '').split(/\s+/).includes(className);
          const value = double ?? single ?? bare;
          const name = attr.toLowerCase();
          return value === undefined
            ? element => element.getAttribute(name) !== null
            : element => element.getAttribute(name) === value;
        });
      return element => (!tag || element.localName === tag) && checks.every(check => check(element));
    });
  }

  function* descendants(node) {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      yield child;
      yield* descendants(child);
    }
  }

  // --- Nodos ---------------------------------------------------------------------

  class LiteNode {
    constructor(nodeType, ownerDocument) {
      this.nodeType = nodeType;
      this.ownerDocument = ownerDocument;
      this.parentNode = null;
      this.childNodes = [];
    }

    get children() {
      return this.childNodes.filter(child => child.nodeType === 1);
    }

    appendChild(node) {
      if (node.parentNode) node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }

    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.childNodes;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    }

    replaceWith(node) {
      const parent = this.parentNode;
      if (!parent) return;
      if (node.parentNode) node.remove();
      parent.childNodes.splice(parent.childNodes.indexOf(this), 1, node);
      node.parentNode = parent;
      this.parentNode = null;
    }

    querySelectorAll(selector) {
      const matchers = compileSelector(selector);
      return [...descendants(this)].filter(element => matchers.some(matches => matches(element)));
    }

    querySelector(selector) {
      const matchers = compileSelector(selector);
      for (const element of descendants(this)) {
        if (matchers.some(matches => matches(element))) return element;
      }
      return null;
    }

    get textContent() {
      return this.childNodes.map(child => child.textContent).join('');
    }

    get innerText() {
      return this.textContent;
    }
  }

  class LiteText extends LiteNode {
    constructor(data, ownerDocument) {
      super(3, ownerDocument);
      this.data = data;
    }

    get textContent() {
      return this.data;
    }

    cloneNode() {
      return new LiteText(this.data, this.ownerDocument);
    }
  }

  class LiteElement extends LiteNode {
    constructor(localName, attributes, ownerDocument) {
      super(1, ownerDocument);
      this.localName = localName;
      this.tagName = localName.toUpperCase();
      this.attributes = attributes;
    }

    getAttribute(name) {
      const value = this.attributes.get(String(name).toLowerCase());
      return value === undefined ? null : value;
    }

    cloneNode(deep = false) {
      const clone = new LiteElement(this.localName, new Map(this.attributes), this.ownerDocument);
      if (deep) this.childNodes.forEach(child => clone.appendChild(child.cloneNode(true)));
      return clone;
    }
  }

  class LiteDocument extends LiteNode {
    constructor() {
      super(9, null);
      this.documentElement = this.appendChild(this.createElement('html'));
      this.head = this.documentElement.appendChild(this.createElement('head'));
      this.body = null;
    }

    createElement(name) {
      return new LiteElement(String(name).toLowerCase(), new Map(), this);
    }

    createTextNode(data) {
      return new LiteText(String(data), this);
    }
  }

  // --- Análisis --------------------------------------------------------------------

  function parseLiteHtml(html) {
    const doc = new LiteDocument();
    const source = String(html ?? '');
    // Pila de elementos abiertos dentro del cuerpo; vacía hasta que empieza.
    let stack = [];
    let headOpen = false;

    const startBody = (attributes = new Map()) => {
      if (doc.body) return;
      doc.body = new LiteElement('body', attributes, doc);
      doc.documentElement.appendChild(doc.body);
      stack = [doc.body];
      headOpen = false;
    };
    const current = () => stack[stack.length - 1];
    const closeUntil = (index) => { stack.length = Math.max(1, index); };
    const findOpen = (names, scope = []) => {
      for (let i = stack.length - 1; i > 0; i--) {
        if (names.includes(stack[i].localName)) return i;
        if (scope.includes(stack[i].localName)) return -1;
      }
      return -1;
    };
    const appendText = (text) => {
      if (!text) return;
      if (!doc.body) {
        if (!text.trim()) return;
        startBody();
      }
      const parent = current();
      const last = parent.childNodes[parent.childNodes.length - 1];
      if (last?.nodeType === 3) last.data += text;
      else parent.appendChild(doc.createTextNode(text));
    };

    const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([a-z][^\s/>]*)[^>]*>|<([a-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|[^<]+|</gi;
    let match;
    while ((match = tokens.exec(source)) !== null) {
      const [token, closingName, openingName, attributeSource, selfClosing] = match;
      if (closingName) {
        const name = closingName.toLowerCase();
        if (name === 'body' || name === 'html') continue;
        if (name === 'head') { headOpen = false; continue; }
        if (name === 'p' && doc.body && findOpen(['p']) === -1) {
          current().appendChild(doc.createElement('p'));
          continue;
        }
        const index = findOpen([name]);
        if (index > 0) closeUntil(index);
        continue;
      }
      if (!openingName) {
        if (token[0] !== '<' || token === '<') appendText(decodeEntities(token));
        continue;
      }

      const name = openingName.toLowerCase();
      const attributes = parseAttributes(attributeSource);
      if (name === 'html') continue;
      if (name === 'head') { if (!doc.body) headOpen = true; continue; }
      if (name === 'body') { startBody(attributes); continue; }

      const element = new LiteElement(name, attributes, doc);
      const inHead = !doc.body && (headOpen || HEAD_ELEMENTS.has(name));
      if (!inHead) {
        startBody();
        if (CLOSES_PARAGRAPH.has(name)) {
          const paragraph = findOpen(['p'], ['button', 'table']);
          if (paragraph > 0) closeUntil(paragraph);
        }
        const implied = IMPLIED_END[name];
        if (implied) {
          const index = findOpen(implied.closes, implied.scope);
          if (index > 0) closeUntil(index);
        }
      }
      (inHead ? doc.head : current()).appendChild(element);

      if (RAW_TEXT_ELEMENTS.has(name) || ESCAPABLE_RAW_TEXT_ELEMENTS.has(name)) {
        const end = new RegExp(`</${name}\\s*>`, 'ig');
        end.lastIndex = tokens.lastIndex;
        const found = end.exec(source);
        const content = source.slice(tokens.lastIndex, found ? found.index : source.length);
        if (content) element.appendChild(doc.createTextNode(RAW_TEXT_ELEMENTS.has(name) ? content : decodeEntities(content)));
        tokens.lastIndex = found ? end.lastIndex : source.length;
        continue;
      }
      if (!inHead && !VOID_ELEMENTS.has(name) && !selfClosing) stack.push(element);
    }
    startBody();
    return doc;
  }

  /** Documento HTML: el del DOMParser del navegador o, sin él (Node.js), el árbol ligero. */
  function parseHtml(html) {
    if (typeof DOMParser === 'function') return new DOMParser().parseFromString(html, 'text/html');
    return parseLiteHtml(html);
  }

  return { parseHtml };
}));
