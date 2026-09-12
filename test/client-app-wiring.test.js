// Page wiring. src/client/app.js is the only module the browser runs that the
// seam tests do not touch, so it is exercised here against a minimal fake DOM and
// a live broker: real HTTP, real HPKE, fake elements.
//
// This is not a substitute for opening the page in a browser engine — it proves
// the element ids, the state transitions and the send path line up, nothing about
// rendering.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import { claimFileDrop, splitHandoffUrl, startTestBroker } from './helpers/harness.js';

const ELEMENT_IDS = ['app', 'form', 'success', 'unavailable', 'secret', 'send', 'note', 'ttl', 'file-panel', 'files', 'drop-zone', 'file-list', 'file-total', 'form-title', 'form-lede-text', 'request-description', 'files-heading', 'files-limits'];

function fakeDom() {
  function element(id = '') {
    return { id, hidden: false, value: '', textContent: '', disabled: false, readOnly: false,
      dataset: {}, focused: false, files: [], children: [], attributes: new Map(), handlers: new Map(),
      classList: { add() {}, remove() {} }, focus() { this.focused = true; },
      setAttribute(name, value) { this.attributes.set(name, value); },
      get innerHTML() { throw new Error('innerHTML read on a node the page must build as text'); },
      set innerHTML(_value) { throw new Error('innerHTML written: the page must never build a node from a string'); },
      addEventListener(type, handler) { this.handlers.set(type, handler); },
      append(...children) { this.children.push(...children); } };
  }
  const elements = new Map(ELEMENT_IDS.map((id) => [id, element(id)]));
  const documentHandlers = new Map();
  // Every node the page builds, recorded. The descriptor is requester-authored text
  // rendered into a page a person is about to paste a credential into, so "it was
  // written as text and never became an element" has to be checkable rather than
  // assumed -- see the hostile-copy case below, and the same technique in
  // test/reveal-page.test.js.
  const created = [];
  return { elements, documentHandlers, created, document: { hidden: false,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => { const node = element(); node.tag = tag; created.push(node); return node; },
    addEventListener(type, handler) { documentHandlers.set(type, handler); } } };
}

function fileLike(name, bytes, type = '') {
  const copy = Uint8Array.from(bytes);
  return { name, type, size: copy.byteLength, async arrayBuffer() { return copy.slice().buffer; } };
}

/** Loads app.js afresh with the given fragment, since it runs on import. */
async function loadApp({ hash, origin }) {
  const dom = fakeDom();
  const timers = [];
  const intervals = new Map();
  let nextIntervalId = 1;
  globalThis.document = dom.document;
  globalThis.window = {
    location: { hash, origin },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    setInterval: (fn, ms) => {
      const id = nextIntervalId;
      nextIntervalId += 1;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
  };

  // Cache-bust so each scenario gets a fresh module instance.
  await import(`../src/client/app.js?scenario=${encodeURIComponent(hash)}${Math.random()}`);
  // Let start()'s metadata fetch settle.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    ...dom,
    timers,
    intervals,
    /** Fires every armed interval once, the way a live tab would each second. */
    tick() {
      for (const { fn } of [...intervals.values()]) fn();
    },
  };
}

describe('the page script wiring', () => {
  let broker;

  before(async () => {
    broker = await startTestBroker();
  });

  after(async () => {
    await broker.stop();
    delete globalThis.document;
    delete globalThis.window;
  });

  it('references only element ids that exist in index.html', async () => {
    const html = await readFile(new URL('../src/public/index.html', import.meta.url), 'utf8');
    for (const id of ELEMENT_IDS) {
      assert.match(html, new RegExp(`id="${id}"`), `index.html must define #${id}`);
    }
  });

  it('shows the unavailable screen when the fragment is missing or malformed', async () => {
    for (const hash of ['', '#', '#not-a-capability', `#${'z'.repeat(21)}`]) {
      const dom = await loadApp({ hash, origin: broker.baseUrl });
      assert.equal(dom.elements.get('unavailable').hidden, false, `hash ${JSON.stringify(hash)}`);
      assert.equal(dom.elements.get('form').hidden, true);
      assert.equal(dom.elements.get('app').dataset.state, 'unavailable');
    }
  });

  it('shows the unavailable screen for a consumed handoff', async () => {
    const created = await broker.control({ op: 'create' });
    const { capability } = splitHandoffUrl(created.url);
    const { sendSecret } = await import('../src/client/handoff-client.js');
    await sendSecret({ capability, plaintext: 'already used', origin: broker.baseUrl });

    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });
    assert.equal(dom.elements.get('unavailable').hidden, false);
  });

  // A files drop used to be refused outright here: the page was a text page, and
  // `payload_kind: "files"` metadata carries no `max_plaintext_bytes` at all, so
  // rendering the text form would have left the pre-send size guard comparing against
  // `undefined` -- always false -- and an arbitrarily large secret would have been
  // sealed into a lane the broker then refused on the version mismatch.
  //
  // The link is now renderable because the page has a file lane to offer it, and the
  // old hazard is closed by construction rather than by refusing the drop: the
  // textarea is hidden for this kind and the send gate requires files, so the text
  // path is unreachable. The assertion below is the one that still matters -- nothing
  // text-shaped may be sealed into a files drop, however the button is driven.
  it('offers the file form for a files drop and never seals a text lane into it', async () => {
    const created = await broker.control({ op: 'create', payload_kind: 'files' });
    const { capability } = splitHandoffUrl(created.url);

    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    assert.equal(dom.elements.get('form').hidden, false, 'the form is offered');
    assert.equal(dom.elements.get('unavailable').hidden, true);
    assert.equal(dom.elements.get('app').dataset.state, 'form');
    assert.equal(dom.elements.get('secret').hidden, true, 'with no textarea to fill');
    assert.equal(dom.elements.get('file-panel').hidden, false, 'and the picker shown');

    // Driving the button with text typed into the hidden textarea must seal nothing:
    // the gate refuses an empty file selection, so no envelope is built at all.
    dom.elements.get('secret').value = 'a secret typed into the wrong lane';
    await dom.elements.get('send').handlers.get('click')();

    assert.equal(broker.testSnapshot(created.handoff_id).state, 'pending', 'nothing submitted');
    assert.match(dom.elements.get('note').textContent, /files/i, 'and it says what it wants');
  });

  it('adapts the controls and the built-in copy to each payload kind', async () => {
    // Which controls appear is decided by the broker-declared kind, never by the
    // descriptor: the mode is bound into the AEAD and the copy is not, so a
    // descriptor must not be able to talk the page into offering a lane the drop
    // cannot accept.
    const cases = [
      { kind: 'text', textarea: false, panel: true, title: /text/i },
      { kind: 'files', textarea: true, panel: false, title: /files/i },
      { kind: 'universal', textarea: false, panel: false, title: /^Send privately to Hermes$/ },
    ];
    for (const { kind, textarea, panel, title } of cases) {
      const created = await broker.control({ op: 'create', payload_kind: kind });
      const { capability } = splitHandoffUrl(created.url);
      const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

      assert.equal(dom.elements.get('form').hidden, false, `${kind}: the form renders`);
      assert.equal(dom.elements.get('secret').hidden, textarea, `${kind}: textarea visibility`);
      assert.equal(dom.elements.get('file-panel').hidden, panel, `${kind}: file panel visibility`);
      assert.match(dom.elements.get('form-title').textContent, title, `${kind}: heading`);
      // The expiry and secrecy sentence is the page's own and is never rewritten.
      assert.equal(dom.elements.get('request-description').hidden, true, `${kind}: no descriptor`);
    }
  });

  it('gates send on an exact file count, and says which rule was met', async () => {
    const created = await broker.control({
      op: 'create',
      payload_kind: 'files',
      max_files: 5,
      form: { description: 'Upload the two staging config files.', expect_files: 2 },
    });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    assert.equal(dom.elements.get('request-description').hidden, false);
    assert.equal(
      dom.elements.get('request-description').textContent,
      'Upload the two staging config files.',
    );
    // The count is stated once, in the heading; the line beside it carries the size
    // ceiling, which is the part the heading does not already say.
    assert.match(dom.elements.get('files-heading').textContent, /Add 2 files/);
    assert.match(dom.elements.get('files-limits').textContent, /MiB total/);
    assert.doesNotMatch(dom.elements.get('files-limits').textContent, /2 files/);

    // One file of two: the count is short, so Send does nothing and the panel says
    // how far along the selection is.
    const input = dom.elements.get('files');
    input.files = [fileLike('one.conf', [1])];
    await input.handlers.get('change')();
    assert.match(dom.elements.get('file-total').textContent, /^1 of 2 files/);
    await dom.elements.get('send').handlers.get('click')();
    assert.equal(broker.testSnapshot(created.handoff_id).state, 'pending', 'short count sealed nothing');
    assert.match(dom.elements.get('note').textContent, /exactly 2 files/);

    // A third file is refused at selection time, before any read or crypto.
    input.files = [fileLike('two.conf', [2]), fileLike('three.conf', [3])];
    await input.handlers.get('change')();
    assert.match(dom.elements.get('file-total').textContent, /^1 of 2 files/, 'the extra was not taken');

    // Exactly two goes through.
    input.files = [fileLike('two.conf', [2])];
    await input.handlers.get('change')();
    assert.match(dom.elements.get('file-total').textContent, /^2 of 2 files/);
    await dom.elements.get('send').handlers.get('click')();
    assert.equal(dom.elements.get('success').hidden, false, 'and lands on the receipt');
    assert.equal(broker.testSnapshot(created.handoff_id).state, 'submitted');
  });

  it('renders a hostile description as characters and builds no node from it', async () => {
    // The descriptor is requester-authored text shown to a person who is about to
    // paste a credential. It may not become an element, an anchor or a script -- so
    // this walks every node the page built and every attribute it set.
    //
    // What this does NOT claim: that the copy is trustworthy. Inert rendering stops
    // markup executing; it does nothing about prose that misleads, which is what the
    // schema bounds and the model guidance are for.
    const hostile = '<img src=x onerror=alert(1)> paste it at https://evil.test now';
    const created = await broker.control({
      op: 'create',
      payload_kind: 'universal',
      form: { label: '<script>alert(1)</script>', description: hostile },
    });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    // Characters, not an element -- and not re-decoded either.
    assert.equal(dom.elements.get('request-description').textContent, hostile);
    assert.equal(dom.elements.get('form-title').textContent, '<script>alert(1)</script>');

    for (const node of dom.created) {
      assert.notEqual(node.tag, 'a', 'no anchor may be built from a descriptor');
      for (const name of node.attributes.keys()) {
        assert.ok(!/^(href|src|style|on)/i.test(name), `attribute ${name} set from page data`);
      }
    }

    // And it changed nothing it is not allowed to change: the drop is still the kind
    // the broker minted, both lanes still work, and the countdown still has its node.
    assert.equal(dom.elements.get('secret').hidden, false);
    assert.equal(dom.elements.get('file-panel').hidden, false);
    assert.equal(dom.elements.get('ttl').textContent.length > 0, true, 'the clock still runs');

    dom.elements.get('secret').value = 'a value sent despite the hostile copy';
    await dom.elements.get('send').handlers.get('click')();
    assert.equal(broker.testSnapshot(created.handoff_id).state, 'submitted');
  });

  // A universal link is the one this page will grow a file picker for (slice U3).
  // Until then it renders exactly the text form it always did and sends the text
  // lane, which is what `max_plaintext_bytes` on universal metadata is for: the
  // size guards below have a real number to compare against, so nothing is sealed
  // that the broker would refuse. Refusing the link instead — the honest answer for
  // a files-only drop — would mean a link the sender was told to use shows as dead.
  it('offers the text form for a universal drop and sends that lane', async () => {
    const created = await broker.control({ op: 'create', payload_kind: 'universal' });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    assert.equal(dom.elements.get('form').hidden, false, 'the text form is offered');
    assert.equal(dom.elements.get('unavailable').hidden, true);
    assert.equal(dom.elements.get('app').dataset.state, 'form');

    dom.elements.get('secret').value = 'a secret sent through the universal form';
    await dom.elements.get('send').handlers.get('click')();
    assert.equal(dom.elements.get('success').hidden, false, 'and lands on the receipt');
    const snapshot = broker.testSnapshot(created.handoff_id);
    assert.equal(snapshot.state, 'submitted');
    assert.equal(snapshot.payloadKind, 'text', 'the sender chose the text lane');
  });

  it('drives the one browser form file path with binary and five-file File-like inputs', async () => {
    for (const bodies of [[[0, 255, 1, 128, 10]], [[], [0], [1, 2], [254, 255, 0], [9, 8, 7, 6]]]) {
      const created = await broker.control({ op: 'create', payload_kind: 'universal' });
      const { capability } = splitHandoffUrl(created.url);
      const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });
      const input = dom.elements.get('files'); input.files = bodies.map((body, i) => fileLike(`f${i}.bin`, body));
      await input.handlers.get('change')(); await dom.elements.get('send').handlers.get('click')();
      const claimed = await claimFileDrop(broker, created.handoff_id);
      assert.deepEqual(claimed.files.map((f) => f.size), bodies.map((b) => b.length));
      for (let i = 0; i < bodies.length; i += 1) {
        assert.deepEqual([...claimed.files[i].bytes], bodies[i]);
      }
    }
  });

  it('removes files and preserves text and file drafts across explicit mode switches', async () => {
    const created = await broker.control({ op: 'create', payload_kind: 'universal' });
    const { capability } = splitHandoffUrl(created.url); const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });
    const textarea = dom.elements.get('secret'); textarea.value = 'preserved draft';
    const input = dom.elements.get('files'); input.files = [fileLike('keep.bin', [1]), fileLike('remove.bin', [2])]; await input.handlers.get('change')();
    await dom.elements.get('file-list').children[1].children[2].handlers.get('click')();
    assert.equal(textarea.value, 'preserved draft');
    assert.match(dom.elements.get('file-total').textContent, /^1 file/);
  });

  it('rejects over-count and over-size before reading, crypto, or network', async () => {
    for (const files of [Array.from({ length: 6 }, (_, i) => fileLike(`${i}.bin`, [i])),
      [{ name: 'huge.bin', type: '', size: 42 * 1024 * 1024 + 1, async arrayBuffer() { throw new Error('read'); } }]]) {
      const created = await broker.control({ op: 'create', payload_kind: 'universal' }); const { capability } = splitHandoffUrl(created.url);
      const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });       const input = dom.elements.get('files'); input.files = files; await input.handlers.get('change')(); await dom.elements.get('send').handlers.get('click')();
      assert.equal(broker.testSnapshot(created.handoff_id).state, 'pending'); assert.match(dom.elements.get('note').textContent, /at most/);
    }
  });

  it('declares files with HPKE v2 and retries the exact sealed request', async () => {
    const created = await broker.control({ op: 'create', payload_kind: 'universal' }); const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });     const input = dom.elements.get('files'); input.files = [fileLike('retry.bin', [72, 68, 82, 79, 80, 50, 0])]; await input.handlers.get('change')();
    const realFetch = globalThis.fetch; const requests = [];
    globalThis.fetch = async (url, options) => { if (String(url).endsWith('/api/submit')) { requests.push({ header: options.headers['X-Handoff-Payload'], body: String(options.body) }); throw new TypeError('offline'); } return realFetch(url, options); };
    try {
      await dom.elements.get('send').handlers.get('click')(); assert.equal(requests.length, 2); assert.equal(requests[0].header, 'files'); assert.equal(JSON.parse(requests[0].body).v, 2); assert.deepEqual(requests[1], requests[0]);
      globalThis.fetch = async (url, options) => { if (String(url).endsWith('/api/submit')) requests.push({ header: options.headers['X-Handoff-Payload'], body: String(options.body) }); return realFetch(url, options); };
      await dom.elements.get('send').handlers.get('click')(); assert.deepEqual(requests[2], requests[0]);
    } finally { globalThis.fetch = realFetch; }
  });

  it('renders the form, sends once, and lands on the receipt', async () => {
    const created = await broker.control({ op: 'create' });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    const form = dom.elements.get('form');
    const textarea = dom.elements.get('secret');
    const send = dom.elements.get('send');

    assert.equal(form.hidden, false, 'a live capability renders the form');
    assert.equal(dom.elements.get('app').dataset.state, 'form');
    assert.match(dom.elements.get('ttl').textContent, /^(29|30):\d{2}$/, 'a live m:ss countdown');
    assert.equal(textarea.focused, true);
    assert.ok(
      [...dom.intervals.values()].some((interval) => interval.ms === 1000),
      'the page arms a one-second countdown ticker',
    );

    // Empty send is a no-op.
    await send.handlers.get('click')();
    assert.equal(form.hidden, false);
    assert.equal(broker.testSnapshot(created.handoff_id).state, 'pending');

    textarea.value = 'PGADMIN_DEFAULT_PASSWORD=example-not-a-real-secret';
    await textarea.handlers.get('input')();
    assert.equal(dom.elements.get('note').textContent, 'One secure send · no edits');

    await send.handlers.get('click')();
    assert.equal(dom.elements.get('success').hidden, false, 'success screen after send');
    assert.equal(form.hidden, true);
    assert.equal(send.disabled, true, 'the send button cannot be pressed twice');
    assert.equal(textarea.value, '', 'the visible copy is cleared once sealed');

    const snapshot = broker.testSnapshot(created.handoff_id);
    assert.equal(snapshot.state, 'submitted');
    assert.equal(snapshot.hasPrivateKey, false);
  });

  it('keeps the pasted text when the broker is unreachable, then resends the same envelope', async () => {
    const created = await broker.control({ op: 'create' });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    const textarea = dom.elements.get('secret');
    const send = dom.elements.get('send');
    const note = dom.elements.get('note');
    const plaintext = 'REDIS_PASSWORD=example-not-a-real-secret';
    textarea.value = plaintext;

    const realFetch = globalThis.fetch;
    const submissions = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith('/api/submit')) {
        submissions.push(String(options.body));
        throw new TypeError('fetch failed');
      }
      return realFetch(url, options);
    };

    try {
      await send.handlers.get('click')();

      // Nothing definitive came back, so the payload must still be here.
      assert.equal(dom.elements.get('form').hidden, false, 'stays on the form');
      assert.equal(dom.elements.get('unavailable').hidden, true, 'a timeout is not a refusal');
      assert.equal(textarea.value, plaintext, 'the pasted text must not be lost');
      assert.equal(send.disabled, false, 'the operator can try again');
      assert.match(note.textContent, /again/i, 'and is told so');
      assert.equal(submissions.length, 2, 'the client already retried the same bytes once');
      assert.equal(submissions[0], submissions[1]);
      assert.equal(broker.testSnapshot(created.handoff_id).state, 'pending');

      // Network back: pressing Send must resend the sealed envelope, not re-seal.
      globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/api/submit')) submissions.push(String(options.body));
        return realFetch(url, options);
      };
      await send.handlers.get('click')();

      assert.equal(submissions.length, 3);
      assert.equal(
        JSON.parse(submissions[2]).ct,
        JSON.parse(submissions[0]).ct,
        'the same sealed ciphertext is resent',
      );
      assert.equal(dom.elements.get('success').hidden, false, 'receipt at last');
      assert.equal(textarea.value, '', 'cleared only once the receipt is definitive');

      const snapshot = broker.testSnapshot(created.handoff_id);
      assert.equal(snapshot.state, 'submitted');
      assert.equal(
        snapshot.plaintextBytes,
        Buffer.byteLength(plaintext, 'utf8'),
        'delivered exactly once',
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('counts the remaining time down and refreshes when the tab comes back', async () => {
    const created = await broker.control({ op: 'create', ttl_seconds: 120 });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    const ttl = dom.elements.get('ttl');
    assert.match(ttl.textContent, /^[12]:\d{2}$/, 'starts near two minutes');
    assert.match(
      ttl.attributes.get('aria-label'),
      /^[12] minutes? left$/,
      'the unannounced digits get a readable whole-minute label',
    );
    const first = ttl.textContent;

    await new Promise((resolve) => setTimeout(resolve, 1100));
    dom.tick();
    assert.notEqual(ttl.textContent, first, 'the label moves with real elapsed time');
    assert.match(ttl.textContent, /^[01]:\d{2}$/);

    // A throttled background tab can miss ticks, so returning must resync
    // rather than trust the timer.
    const beforeResync = ttl.textContent;
    ttl.textContent = 'stale';
    const onVisibility = dom.documentHandlers.get('visibilitychange');
    assert.ok(onVisibility, 'the page listens for visibilitychange');
    onVisibility();
    assert.equal(ttl.textContent, beforeResync, 'resynced from the deadline, not the timer');
  });

  it('closes the form when the countdown reaches zero', async () => {
    const created = await broker.control({ op: 'create', ttl_seconds: 1 });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });
    assert.equal(dom.elements.get('form').hidden, false, 'live at load');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    dom.tick();

    assert.equal(dom.elements.get('unavailable').hidden, false, 'expired in the browser too');
    assert.equal(dom.elements.get('form').hidden, true);
    assert.equal(dom.elements.get('ttl').textContent, '0:00');
  });

  it('stops the countdown once the receipt is shown, so it cannot overwrite it', async () => {
    const created = await broker.control({ op: 'create', ttl_seconds: 1 });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    dom.elements.get('secret').value = 'STAGING_TOKEN=example-not-a-real-secret';
    await dom.elements.get('send').handlers.get('click')();
    assert.equal(dom.elements.get('success').hidden, false);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    dom.tick();
    assert.equal(dom.elements.get('success').hidden, false, 'the receipt survives the expiry');
    assert.equal(dom.elements.get('unavailable').hidden, true);
  });

  // The interval is only one of the two ways a stale countdown can fire. The
  // visibilitychange listener is registered once and never removed, so it
  // outlives the ticker — and telling someone who *did* deliver a credential
  // that the link failed is an invitation to resend it into the chat channel,
  // which is the one outcome this system exists to prevent.
  it('cannot repaint the receipt when the tab returns after expiry', async () => {
    const created = await broker.control({ op: 'create', ttl_seconds: 1 });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    dom.elements.get('secret').value = 'DEPLOY_KEY=example-not-a-real-secret';
    await dom.elements.get('send').handlers.get('click')();
    assert.equal(dom.elements.get('success').hidden, false, 'delivered');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    dom.tick();
    dom.documentHandlers.get('visibilitychange')();

    assert.equal(dom.elements.get('success').hidden, false, 'the receipt is still the answer');
    assert.equal(dom.elements.get('unavailable').hidden, true, 'a delivered secret is not a failure');
    assert.equal(dom.elements.get('app').dataset.state, 'success');
  });

  it('cannot repaint the unavailable screen when the tab returns after expiry', async () => {
    const created = await broker.control({ op: 'create', ttl_seconds: 1 });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    await new Promise((resolve) => setTimeout(resolve, 1100));
    dom.tick();
    assert.equal(dom.elements.get('unavailable').hidden, false, 'expired');

    dom.elements.get('ttl').textContent = 'untouched';
    dom.documentHandlers.get('visibilitychange')();

    assert.equal(dom.elements.get('unavailable').hidden, false);
    assert.equal(dom.elements.get('form').hidden, true, 'and the form does not come back');
    assert.equal(
      dom.elements.get('ttl').textContent,
      'untouched',
      'a detached countdown writes nothing at all',
    );
  });

  it('warns instead of sending when the payload exceeds the ceiling', async () => {
    const created = await broker.control({ op: 'create' });
    const { capability } = splitHandoffUrl(created.url);
    const dom = await loadApp({ hash: `#${capability}`, origin: broker.baseUrl });

    dom.elements.get('secret').value = 'x'.repeat(65537);
    await dom.elements.get('send').handlers.get('click')();
    assert.match(dom.elements.get('note').textContent, /Too large/);


    assert.equal(dom.elements.get('form').hidden, false, 'still on the form');
    assert.equal(broker.testSnapshot(created.handoff_id).state, 'pending');
  });
});
