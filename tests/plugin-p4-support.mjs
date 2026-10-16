// Mocked DOM for the P4 tests (provider-settings.js, chat-controls.js, plugin-settings.js).
// Just enough of the DOM those modules touch: elements with children, attributes, dataset,
// listeners, <select> value/options semantics and the Option constructor. Not a browser:
// nothing here is visual verification.
export class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.htmlFor = '';
    this.type = '';
    this._text = '';
    this._value = '';
    this._selected = null;
    this._none = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }
  get textContent() { return this._text + this.children.map((child) => child instanceof El ? child.textContent : String(child)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get value() {
    if (this.tag !== 'select') return this._value;
    const options = this.options;
    if (this._selected && options.includes(this._selected)) return this._selected.value;
    if (this._none) return '';
    return options[0]?.value ?? '';
  }
  set value(value) {
    if (this.tag !== 'select') { this._value = String(value); return; }
    this._selected = this.options.find((option) => option.value === String(value)) ?? null;
    this._none = !this._selected;
  }
  get options() { return this.children.filter((child) => child instanceof El && child.tag === 'option'); }
  get selectedOptions() {
    const value = this.value;
    const found = this.options.find((option) => option.value === value);
    return found ? [found] : [];
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof El) {
        node.parent?.removeChild(node);
        node.parent = this;
      }
      this.children.push(node);
    }
    this._none = false;
  }
  add(option) { this.append(option); }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    if (node instanceof El) node.parent = null;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) if (child instanceof El) child.parent = null;
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  remove() { this.parent?.removeChild(this); }
  before() {}
  contains(node) { return all(this).includes(node); }
  closest() { return null; }
  querySelector() { return null; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  async dispatch(type) {
    for (const listener of this.listeners[type] ?? []) await listener({ type, target: this, preventDefault() {}, stopPropagation() {} });
  }
  click() { return this.dispatch('click'); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  focus() { globalThis.document.activeElement = this; }
  scrollTo() {}
  getBoundingClientRect() { return { top: 0 }; }
}
export class FakeOption extends El {
  constructor(text = '', value) {
    super('option');
    this.textContent = text;
    this.value = value === undefined ? text : value;
  }
}
export const all = (node) => [node, ...node.children.filter((child) => child instanceof El).flatMap(all)];
export const text = (node) => node.textContent;

/** Installs document/window/Option globals over fixed elements ({id: tag}); returns {fixed, restore}. */
export function installDom(tags, setup = () => {}) {
  const fixed = Object.fromEntries(Object.entries(tags).map(([id, tag]) => [id, Object.assign(new El(tag), { id })]));
  setup(fixed);
  const saved = { document: globalThis.document, window: globalThis.window, Option: globalThis.Option, MutationObserver: globalThis.MutationObserver, ResizeObserver: globalThis.ResizeObserver, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.document = {
    activeElement: null,
    createElement: (tag) => new El(tag),
    getElementById(id) {
      if (fixed[id]) return fixed[id];
      for (const root of Object.values(fixed)) {
        const found = all(root).find((node) => node.id === id);
        if (found) return found;
      }
      return null;
    },
    addEventListener() {}
  };
  globalThis.window = { addEventListener() {}, innerHeight: 800, visualViewport: undefined };
  globalThis.Option = FakeOption;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.getComputedStyle = () => ({ maxHeight: '144px' });
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  return {
    fixed,
    restore() {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    }
  };
}

/** The static #mode select of index.html (built-in options only). */
export function builtinModeOptions(select) {
  for (const [value, label] of [['offline', 'Offline demo'], ['chatgpt', 'ChatGPT'], ['claude', 'Claude Code'], ['openai', 'OpenAI API key']]) select.add(new FakeOption(label, value));
}
