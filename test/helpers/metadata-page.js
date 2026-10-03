// Minimal DOM for the production page entry point; rendering is checked in Chrome.
const realFetch = globalThis.fetch;

export async function loadMetadataPage(hash, origin, fault) {
  const nodes = new Map();
  const timers = new Map();
  const intervals = new Map();
  const listeners = [];
  let timerId = 0;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: true, value: '', textContent: '', dataset: {}, files: [], children: [],
      handlers: new Map(), attributes: new Map(), classList: { add() {}, remove() {} },
      focus() {}, append(...items) { this.children.push(...items); },
      setAttribute(key, value) { this.attributes.set(key, value); },
      addEventListener(type, fn) { this.handlers.set(type, fn); },
    });
    return nodes.get(id);
  };
  node('app').dataset.state = 'loading';
  globalThis.document = {
    getElementById: node, createElement: () => node(`new-${nodes.size}`),
    addEventListener(type) { listeners.push(type); },
  };
  globalThis.window = {
    location: { hash, origin },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = ++timerId; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
  const requests = [];
  let transport = fault;
  globalThis.fetch = (url, options) => {
    requests.push({ path: new URL(url).pathname, options });
    return transport ? transport(url, options) : realFetch(url, options);
  };
  await import(`../../src/client/app.js?metadata-test=${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return {
    node, timers, intervals, listeners, requests,
    state: () => node('app').dataset.state,
    transport(fn) { transport = fn; },
    retry: () => node('check-retry').handlers.get('click')(),
  };
}
