/**
 * Enough browser to run the files in `public/` under `node --test`.
 *
 * Five of the last six front-end bugs were found by opening the site in a real
 * browser and none by the test suite — credentials rendered into the sign-in
 * page, a cache header that stopped deploys landing, an admin panel whose route
 * reset itself, a signed-out 401 remembered as "no", and the same request sent
 * forty-four times in two seconds. Every one of them is a behaviour, and the
 * suite had no way to express a behaviour, because `public/*.js` needs a DOM to
 * even be imported.
 *
 * This is a shim, deliberately, rather than a dependency. It is small enough to
 * read in one sitting and it covers exactly what our own code uses. What it is
 * NOT is a browser: no layout, no CSS, no real event dispatch order, no forms
 * submitting themselves, no history. A test that passes here is evidence about
 * our code's logic and not about how any browser renders it.
 *
 * The parts that carry the weight:
 *
 *   - `fetch` is recorded, so "how many times did it ask" is an assertion.
 *   - `MutationObserver` delivers on a microtask, so the fetch → render →
 *     observer → fetch loop that produced the storm reproduces here.
 *   - Deliveries are capped, so a loop that does not settle fails the test
 *     instead of hanging the run.
 */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function escapeText(text) {
  return String(text).replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]));
}

function kebab(name) {
  return String(name).replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function camel(name) {
  return String(name).replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
}

/* ------------------------------------------------------------------ selectors */

/** Splits on a separator that is outside quotes, brackets and parentheses. */
function splitTop(input, separator) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const character of input) {
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue; }
    if (character === '[' || character === '(') depth += 1;
    if (character === ']' || character === ')') depth -= 1;
    if (character === separator && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseCompound(source) {
  const compound = { tag: '', id: '', classes: [], attributes: [], not: [] };
  let rest = source;
  while (rest) {
    let match;
    if ((match = /^:not\(([^)]*)\)/.exec(rest))) {
      compound.not.push(parseCompound(match[1].trim()));
    } else if ((match = /^\[([^\]]*)\]/.exec(rest))) {
      const body = match[1];
      const operator = /^([^~^$*|=]+)(?:([~^$*|]?=)\s*(.*))?$/.exec(body);
      const value = operator[3] ? operator[3].replace(/^["']|["']$/g, '') : null;
      compound.attributes.push({ name: operator[1].trim().toLowerCase(), operator: operator[2] ?? null, value });
    } else if ((match = /^#([\w-]+)/.exec(rest))) {
      compound.id = match[1];
    } else if ((match = /^\.([\w-]+)/.exec(rest))) {
      compound.classes.push(match[1]);
    } else if ((match = /^\*/.exec(rest))) {
      compound.tag = '';
    } else if ((match = /^[\w-]+/.exec(rest))) {
      compound.tag = match[0].toUpperCase();
    } else {
      throw new Error(`browser shim: unsupported selector fragment "${rest}" in "${source}"`);
    }
    rest = rest.slice(match[0].length);
  }
  return compound;
}

function parseSelectorList(selector) {
  return splitTop(String(selector), ',').map((part) => {
    if (/[>~+]/.test(part)) {
      // Silently matching the wrong elements is how a harness lies. Our own code
      // does not use combinators; when it starts to, this is the reminder.
      throw new Error(`browser shim: combinators are not supported ("${part}")`);
    }
    return splitTop(part, ' ').map(parseCompound);
  });
}

function attributeMatches(element, condition) {
  if (!element.attributes.has(condition.name)) return false;
  if (condition.operator === null) return true;
  const actual = element.attributes.get(condition.name) ?? '';
  switch (condition.operator) {
    case '=': return actual === condition.value;
    case '^=': return actual.startsWith(condition.value);
    case '$=': return actual.endsWith(condition.value);
    case '*=': return actual.includes(condition.value);
    case '~=': return actual.split(/\s+/).includes(condition.value);
    default: throw new Error(`browser shim: unsupported attribute operator "${condition.operator}"`);
  }
}

function compoundMatches(element, compound) {
  if (element.nodeType !== 1) return false;
  if (compound.tag && element.tagName !== compound.tag) return false;
  if (compound.id && element.getAttribute('id') !== compound.id) return false;
  for (const className of compound.classes) if (!element.classList.contains(className)) return false;
  for (const condition of compound.attributes) if (!attributeMatches(element, condition)) return false;
  for (const negated of compound.not) if (compoundMatches(element, negated)) return false;
  return true;
}

function selectorMatches(element, steps) {
  if (!compoundMatches(element, steps[steps.length - 1])) return false;
  let index = steps.length - 2;
  let ancestor = element.parentNode;
  while (index >= 0) {
    if (!ancestor || ancestor.nodeType !== 1) return false;
    if (compoundMatches(ancestor, steps[index])) index -= 1;
    ancestor = ancestor.parentNode;
  }
  return true;
}

/* ---------------------------------------------------------------------- nodes */

class KgText {
  constructor(data, ownerDocument) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
    this.ownerDocument = ownerDocument;
  }

  get textContent() { return this.data; }

  set textContent(value) { this.data = String(value); }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

class KgClassList {
  constructor(element) { this.element = element; }

  get tokens() {
    return String(this.element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }

  contains(name) { return this.tokens.includes(name); }

  add(...names) {
    const tokens = this.tokens;
    for (const name of names) if (!tokens.includes(name)) tokens.push(name);
    this.element.setAttribute('class', tokens.join(' '));
  }

  remove(...names) {
    this.element.setAttribute('class', this.tokens.filter((token) => !names.includes(token)).join(' '));
  }

  toggle(name, force) {
    const wanted = force === undefined ? !this.contains(name) : Boolean(force);
    if (wanted) this.add(name); else this.remove(name);
    return wanted;
  }
}

function datasetFor(element) {
  return new Proxy({}, {
    get(_, key) {
      if (typeof key !== 'string') return undefined;
      return element.attributes.get(`data-${kebab(key)}`);
    },
    set(_, key, value) {
      element.setAttribute(`data-${kebab(key)}`, String(value));
      return true;
    },
    has(_, key) { return element.attributes.has(`data-${kebab(key)}`); },
    deleteProperty(_, key) { element.removeAttribute(`data-${kebab(key)}`); return true; },
    ownKeys() {
      return [...element.attributes.keys()].filter((name) => name.startsWith('data-')).map((name) => camel(name.slice(5)));
    },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
}

class KgElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = ownerDocument;
    this.listeners = new Map();
    this.style = {};
    this.explicitValue = undefined;
  }

  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }

  get firstElementChild() { return this.children[0] ?? null; }

  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }

  get nextElementSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get previousElementSibling() {
    const siblings = this.parentNode?.children ?? [];
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] : null;
  }

  get classList() { return new KgClassList(this); }

  get className() { return this.getAttribute('class') ?? ''; }

  set className(value) { this.setAttribute('class', String(value)); }

  get id() { return this.getAttribute('id') ?? ''; }

  set id(value) { this.setAttribute('id', String(value)); }

  get dataset() {
    if (!this.datasetProxy) this.datasetProxy = datasetFor(this);
    return this.datasetProxy;
  }

  get disabled() { return this.hasAttribute('disabled'); }

  set disabled(value) {
    if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled');
  }

  /**
   * A control's current value.
   *
   * A `<select>` reports the option marked selected until somebody sets it,
   * which is what makes `kgDurationOptions(90)` observable from a test: the
   * default that markup chose is the value the next request will carry.
   */
  get value() {
    if (this.explicitValue !== undefined) return this.explicitValue;
    if (this.tagName === 'SELECT') {
      const options = this.querySelectorAll('option');
      const selected = options.find((option) => option.hasAttribute('selected')) ?? options[0];
      if (!selected) return '';
      return selected.getAttribute('value') ?? selected.textContent;
    }
    return this.getAttribute('value') ?? '';
  }

  set value(next) { this.explicitValue = String(next); }

  getAttribute(name) {
    const value = this.attributes.get(String(name).toLowerCase());
    return value === undefined ? null : value;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
    this.ownerDocument?.noteMutation(this);
  }

  hasAttribute(name) { return this.attributes.has(String(name).toLowerCase()); }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
    this.ownerDocument?.noteMutation(this);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (String(value)) this.childNodes.push(adopt(this, new KgText(value, this.ownerDocument)));
    this.ownerDocument?.noteMutation(this);
  }

  get innerHTML() { return this.childNodes.map(serialize).join(''); }

  set innerHTML(html) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of parseFragment(String(html), this.ownerDocument)) this.childNodes.push(adopt(this, node));
    this.ownerDocument?.noteMutation(this);
  }

  get outerHTML() { return serialize(this); }

  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new KgText(node, this.ownerDocument) : node;
      if (child.parentNode) child.parentNode.removeChild(child, true);
      this.childNodes.push(adopt(this, child));
    }
    this.ownerDocument?.noteMutation(this);
  }

  appendChild(node) { this.append(node); return node; }

  prepend(...nodes) {
    const adopted = nodes.map((node) => {
      const child = typeof node === 'string' ? new KgText(node, this.ownerDocument) : node;
      if (child.parentNode) child.parentNode.removeChild(child, true);
      return adopt(this, child);
    });
    this.childNodes.unshift(...adopted);
    this.ownerDocument?.noteMutation(this);
  }

  insertBefore(node, reference) {
    if (node.parentNode) node.parentNode.removeChild(node, true);
    const at = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, adopt(this, node));
    this.ownerDocument?.noteMutation(this);
    return node;
  }

  removeChild(node, quiet = false) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    if (!quiet) this.ownerDocument?.noteMutation(this);
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  insertAdjacentHTML(position, html) {
    const nodes = parseFragment(String(html), this.ownerDocument);
    if (position === 'beforeend') {
      for (const node of nodes) this.childNodes.push(adopt(this, node));
    } else if (position === 'afterbegin') {
      this.childNodes.unshift(...nodes.map((node) => adopt(this, node)));
    } else if (position === 'beforebegin' || position === 'afterend') {
      if (!this.parentNode) throw new Error(`browser shim: ${position} needs a parent`);
      const siblings = this.parentNode.childNodes;
      const at = siblings.indexOf(this) + (position === 'afterend' ? 1 : 0);
      siblings.splice(at, 0, ...nodes.map((node) => adopt(this.parentNode, node)));
    } else {
      throw new Error(`browser shim: unknown insert position "${position}"`);
    }
    this.ownerDocument?.noteMutation(this);
  }

  matches(selector) {
    return parseSelectorList(selector).some((steps) => selectorMatches(this, steps));
  }

  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  querySelectorAll(selector) {
    const selectors = parseSelectorList(selector);
    const found = [];
    for (const node of descendants(this)) {
      if (selectors.some((steps) => selectorMatches(node, steps))) found.push(node);
    }
    return found;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  dispatchEvent(event) {
    const target = event.target ?? this;
    let node = this;
    while (node) {
      for (const handler of [...(node.listeners?.get(event.type) ?? [])]) {
        handler.call(node, { ...event, target, currentTarget: node, preventDefault() {}, stopPropagation() {} });
      }
      node = event.bubbles === false ? null : node.parentNode;
    }
  }

  /** What a person clicking would do: dispatch a bubbling click. */
  click() {
    this.dispatchEvent({ type: 'click', target: this, bubbles: true });
  }
}

function adopt(parent, node) {
  node.parentNode = parent;
  if (node.nodeType === 1) {
    node.ownerDocument = parent.ownerDocument;
    for (const child of descendants(node)) child.ownerDocument = parent.ownerDocument;
  }
  return node;
}

function* descendants(root) {
  for (const child of root.childNodes ?? []) {
    if (child.nodeType === 1) {
      yield child;
      yield* descendants(child);
    }
  }
}

function serialize(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  const name = node.tagName.toLowerCase();
  const attributes = [...node.attributes.entries()]
    .map(([key, value]) => ` ${key}="${String(value).replace(/"/g, '&quot;')}"`)
    .join('');
  if (VOID_ELEMENTS.has(name)) return `<${name}${attributes} />`;
  const inner = RAW_TEXT_ELEMENTS.has(name)
    ? node.childNodes.map((child) => child.textContent).join('')
    : node.childNodes.map(serialize).join('');
  return `<${name}${attributes}>${inner}</${name}>`;
}

/* --------------------------------------------------------------------- parser */

function parseAttributes(source) {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    attributes.set(match[1].toLowerCase(), decodeEntities(raw));
  }
  return attributes;
}

/**
 * A tag-soup parser, sized for the markup our own templates emit.
 *
 * Well-formed enough is the contract: no implied end tags, no table fixups, no
 * reparenting. A close tag with no open match is dropped rather than guessed at,
 * because a wrong guess would show up as a passing test.
 */
export function parseFragment(html, ownerDocument) {
  const root = { nodeType: 1, childNodes: [], tagName: 'FRAGMENT', ownerDocument };
  const stack = [root];
  let index = 0;

  const push = (node) => {
    const parent = stack[stack.length - 1];
    node.parentNode = parent === root ? null : parent;
    parent.childNodes.push(node);
  };

  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next === -1) {
      if (index < html.length) push(new KgText(decodeEntities(html.slice(index)), ownerDocument));
      break;
    }
    if (next > index) push(new KgText(decodeEntities(html.slice(index, next)), ownerDocument));

    if (html.startsWith('<!--', next)) {
      const end = html.indexOf('-->', next);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', next)) {
      const end = html.indexOf('>', next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', next)) {
      const end = html.indexOf('>', next);
      const name = html.slice(next + 2, end === -1 ? html.length : end).trim().toUpperCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tagName === name) { stack.length = depth; break; }
      }
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const end = html.indexOf('>', next);
    if (end === -1) { push(new KgText(decodeEntities(html.slice(next)), ownerDocument)); break; }
    const inside = html.slice(next + 1, end);
    const selfClosing = inside.endsWith('/');
    const nameMatch = /^([\w:-]+)/.exec(inside);
    if (!nameMatch) { index = end + 1; continue; }
    const name = nameMatch[1].toLowerCase();
    const element = new KgElement(name, ownerDocument);
    element.attributes = parseAttributes(inside.slice(nameMatch[0].length).replace(/\/$/, ''));
    push(element);
    index = end + 1;

    if (VOID_ELEMENTS.has(name) || selfClosing) continue;
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closing = html.toLowerCase().indexOf(`</${name}`, index);
      const text = html.slice(index, closing === -1 ? html.length : closing);
      if (text) element.childNodes.push(adopt(element, new KgText(text, ownerDocument)));
      const after = closing === -1 ? html.length : html.indexOf('>', closing);
      index = after === -1 ? html.length : after + 1;
      continue;
    }
    stack.push(element);
  }

  for (const node of root.childNodes) node.parentNode = null;
  return root.childNodes;
}

/* ------------------------------------------------------------------- document */

class KgDocument {
  constructor() {
    this.nodeType = 9;
    this.observers = new Set();
    this.mutationScheduled = false;
    this.deliveries = 0;
    this.deliveryCap = 300;
    this.overflowed = false;
    this.listeners = new Map();
    this.documentElement = new KgElement('html', this);
    this.head = new KgElement('head', this);
    this.body = new KgElement('body', this);
    this.documentElement.append(this.head, this.body);
    this.childNodes = [this.documentElement];
    this.documentElement.parentNode = null;
  }

  createElement(tagName) { return new KgElement(tagName, this); }

  createTextNode(data) { return new KgText(data, this); }

  querySelector(selector) { return this.documentElement.matches(selector) ? this.documentElement : this.documentElement.querySelector(selector); }

  querySelectorAll(selector) {
    const found = this.documentElement.querySelectorAll(selector);
    return this.documentElement.matches(selector) ? [this.documentElement, ...found] : found;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener() {}

  /**
   * An event delivered to a document-level listener.
   *
   * `app.js` binds its navigation to `document`, not to each link, so a click
   * that never reaches the document is a click nothing handles — and a test
   * that could not deliver one could not test navigation at all.
   */
  dispatchEvent(event) {
    const target = event.target ?? this.documentElement;
    if (target?.nodeType === 1 && event.bubbles !== false) target.dispatchEvent(event);
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) {
      handler.call(this, { ...event, target, currentTarget: this, preventDefault() {}, stopPropagation() {} });
    }
  }

  noteMutation() {
    if (!this.observers.size || this.mutationScheduled || this.overflowed) return;
    this.mutationScheduled = true;
    queueMicrotask(() => {
      this.mutationScheduled = false;
      this.deliveries += 1;
      if (this.deliveries > this.deliveryCap) {
        // Stop rather than throw: an exception raised in a microtask takes the
        // whole test process with it, and the count is the finding anyway.
        this.overflowed = true;
        return;
      }
      for (const observer of [...this.observers]) observer.callback([], observer);
    });
  }
}

class KgMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.document = null;
  }

  observe(target) {
    this.document = target.ownerDocument ?? target;
    this.document.observers.add(this);
  }

  disconnect() { this.document?.observers.delete(this); }

  takeRecords() { return []; }
}

class KgFormData {
  constructor(form) {
    this.entries = [];
    if (!form) return;
    for (const field of form.querySelectorAll('[name]')) {
      this.entries.push([field.getAttribute('name'), field.value]);
    }
  }

  get(name) { return this.entries.find(([key]) => key === name)?.[1] ?? null; }

  append(name, value) { this.entries.push([name, String(value)]); }

  * [Symbol.iterator]() { yield* this.entries; }
}

/** `sessionStorage`/`localStorage`, in memory and gone with the harness. */
function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => { store.set(String(key), String(value)); },
    removeItem: (key) => { store.delete(String(key)); },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  };
}

/* ------------------------------------------------------------------- the shim */

/**
 * Turns a route table into a `fetch` that records what it was asked.
 *
 * Routes are keyed `"GET /api/thing"` or just `"/api/thing"`, matched most
 * specific first, with `*` as a fallback. A value may be a literal
 * `{ status, body }` or a function of the request, so a test can answer
 * differently the second time and prove the client noticed.
 */
function makeFetch(routes, calls) {
  const table = new Map(Object.entries(routes ?? {}));
  return async function shimFetch(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, globalThis.location?.origin ?? 'https://kukgit.test');
    // `||`, not `??`: an absent method arrives as an empty string as often as
    // it arrives as undefined, and "" is a request nobody made.
    const method = String(init?.method || (typeof input === 'string' ? '' : input.method) || 'GET').toUpperCase();
    calls.push({ method, path: url.pathname, url: raw, body: init?.body ?? null });

    const route = table.get(`${method} ${url.pathname}`) ?? table.get(url.pathname) ?? table.get('*');
    const answer = typeof route === 'function' ? await route({ method, path: url.pathname, url, init }) : route;
    if (!answer) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No route.' } }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      });
    }
    const status = answer.status ?? 200;
    const payload = answer.body === undefined ? {} : answer.body;
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/**
 * Installs the shim as globals and hands back the handles a test needs.
 *
 * `window` is `globalThis`, as it is in a browser, because our own code
 * reassigns `window.fetch` and expects the bare `fetch` call to change with it.
 * Everything installed is removed by `restore()`, which each test must call.
 */
export function installBrowser({ html = '', hash = '#/', origin = 'https://git.kuklabs.test', routes = {} } = {}) {
  const saved = new Map();
  const set = (name, value) => {
    saved.set(name, Object.prototype.hasOwnProperty.call(globalThis, name)
      ? { present: true, value: globalThis[name] }
      : { present: false });
    globalThis[name] = value;
  };

  const document = new KgDocument();
  if (html) document.body.innerHTML = html;

  const calls = [];
  const hashListeners = [];
  const location = {
    origin,
    hash,
    pathname: '/',
    search: '',
    assign() {},
    replace() {},
    get href() { return `${origin}/${this.hash}`; },
  };

  set('document', document);
  set('location', location);
  // Several modules schedule through two nested frames rather than a
  // microtask. A frame is a macrotask here, which is close enough to make the
  // fetch → render → observer → fetch loop reproduce at the same shape.
  //
  // Tracked, because a frame still queued when the test ends fires into a torn
  // down global and reports as an unhandled `requestAnimationFrame is not
  // defined` against whichever test happens to be running.
  const frames = new Set();
  set('requestAnimationFrame', (callback) => {
    const handle = setTimeout(() => { frames.delete(handle); callback(0); }, 0);
    frames.add(handle);
    return handle;
  });
  set('cancelAnimationFrame', (handle) => { frames.delete(handle); clearTimeout(handle); });
  set('sessionStorage', memoryStorage());
  set('localStorage', memoryStorage());
  set('MutationObserver', KgMutationObserver);
  set('FormData', KgFormData);
  set('Element', KgElement);
  set('fetch', makeFetch(routes, calls));
  set('window', globalThis);

  // Several modules start a poll on import — a minute-long `setInterval` that
  // is correct in a browser and, in Node, keeps the event loop alive until the
  // test runner gives up. Recorded here and cleared by `restore()`; unref'd
  // immediately so a forgotten `restore()` fails as an assertion rather than as
  // a hung suite.
  const intervals = new Set();
  const savedSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const handle = savedSetInterval(...args);
    handle?.unref?.();
    intervals.add(handle);
    return handle;
  };

  const windowSaved = {
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    dispatchEvent: globalThis.dispatchEvent,
  };
  globalThis.addEventListener = (type, handler) => { if (type === 'hashchange') hashListeners.push(handler); };
  globalThis.removeEventListener = (type, handler) => {
    const index = hashListeners.indexOf(handler);
    if (type === 'hashchange' && index >= 0) hashListeners.splice(index, 1);
  };

  const harness = {
    document,
    location,
    calls,

    /** Requests made so far, as `"GET /api/thing"` strings. */
    requests() { return calls.map((call) => `${call.method} ${call.path}`); },

    /** How many times a path was asked for, regardless of method. */
    countPath(path) { return calls.filter((call) => call.path === path).length; },

    /** The busiest path and its count — the shape a request storm has. */
    busiest() {
      const counts = new Map();
      for (const call of calls) counts.set(call.path, (counts.get(call.path) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    },

    clearCalls() { calls.length = 0; },

    /** Everything currently rendered, for "is this string on the page" checks. */
    html() { return document.documentElement.innerHTML; },

    /** Changes the hash and fires `hashchange`, the way a link would. */
    navigate(nextHash) {
      location.hash = nextHash;
      for (const handler of [...hashListeners]) handler({ type: 'hashchange' });
    },

    /** True when the DOM never settled — a render loop, not a slow test. */
    get looped() { return document.overflowed; },

    get mutationDeliveries() { return document.deliveries; },

    /** Drains microtasks and timers until the page stops working. */
    async settle(rounds = 12) {
      for (let round = 0; round < rounds; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },

    restore() {
      for (const [name, entry] of saved) {
        if (entry.present) globalThis[name] = entry.value; else delete globalThis[name];
      }
      globalThis.addEventListener = windowSaved.addEventListener;
      globalThis.removeEventListener = windowSaved.removeEventListener;
      globalThis.dispatchEvent = windowSaved.dispatchEvent;
      globalThis.setInterval = savedSetInterval;
      for (const handle of intervals) clearInterval(handle);
      intervals.clear();
      for (const handle of frames) clearTimeout(handle);
      frames.clear();
      document.observers.clear();
    },
  };

  return harness;
}

/**
 * Imports a file from `public/` with a fresh module instance.
 *
 * These modules install themselves on import and keep state at module scope, so
 * a second test in the same file would otherwise inherit the first one's caches
 * and answered-question sets. The query string defeats the ESM cache.
 */
let importCounter = 0;
export function importFresh(specifier) {
  importCounter += 1;
  return import(`${new URL(specifier, import.meta.url).href}?kg=${importCounter}`);
}

export { KgElement, KgDocument, KgFormData };
