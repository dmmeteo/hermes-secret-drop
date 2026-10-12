// Page entry point + real HTTP broker. Only metadata transport is faulted;
// snapshots and the request ledger prove that checking cannot spend a drop.
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { loadMetadataPage } from './helpers/metadata-page.js';
import { createOutboundDrop, splitHandoffUrl, startTestBroker } from './helpers/harness.js';

let broker;
const realFetch = globalThis.fetch;
before(async () => { broker = await startTestBroker(); });
after(async () => {
  globalThis.fetch = realFetch;
  delete globalThis.window;
  delete globalThis.document;
  await broker.stop();
});

const faults = {
  rejection: () => Promise.reject(new TypeError('synthetic network failure')),
  offline: () => Promise.reject(new TypeError('Failed to fetch')),
  408: () => Promise.resolve(new Response('', { status: 408 })),
  429: () => Promise.resolve(new Response('', { status: 429 })),
  503: () => Promise.resolve(new Response('', { status: 503 })),
  malformed: () => Promise.resolve(new Response('<proxy error>')),
  'null-json': () => Promise.resolve(new Response('null')),
  hang: () => new Promise(() => {}),
  'body-hang': () => Promise.resolve({ ok: true, json: () => new Promise(() => {}) }),
};

for (const direction of ['inbound', 'outbound']) {
  async function mint() {
    if (direction === 'outbound') {
      const drop = await createOutboundDrop(broker, { plaintext: 'synthetic retry canary' });
      return { hash: `#${drop.fragment}`, capability: drop.capability, key: drop.key, id: drop.id };
    }
    const created = await broker.control({ op: 'create' });
    const { capability } = splitHandoffUrl(created.url);
    return { hash: `#${capability}`, capability, id: created.handoff_id };
  }
  const path = direction === 'inbound' ? '/api/metadata' : '/api/reveal/metadata';
  const ready = direction === 'inbound' ? 'form' : 'reveal';
  const snapshot = (drop) => direction === 'inbound'
    ? broker.testSnapshot(drop.id) : broker.testOutboundSnapshot(drop.id);

  for (const [name, fault] of Object.entries(faults)) {
    it(`${direction}: ${name} exits loading; Retry checks the same unspent link once`, async () => {
      const drop = await mint();
      const before = snapshot(drop);
      const dom = await loadMetadataPage(drop.hash, broker.baseUrl, fault);
      if (name.includes('hang')) {
        const timeout = [...dom.timers.values()].find(({ ms }) => ms === 20_000);
        assert.ok(timeout, 'metadata has a 20-second deadline');
        timeout.fn();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(dom.requests[0].options.signal.aborted, true);
      }
      assert.equal(dom.state(), 'check-failed');
      let release;
      dom.transport((url, options) => new Promise((resolve) => {
        release = () => resolve(realFetch(url, options));
      }));
      const retry = dom.retry();
      const duplicate = dom.retry();
      assert.equal(dom.requests.length, 2, 'one request despite duplicate activation');
      assert.equal(dom.node('check-retry').textContent, 'Checking…');
      assert.equal(dom.node('check-retry').attributes.get('aria-disabled'), 'true');
      release();
      await Promise.all([retry, duplicate]);
      assert.equal(dom.state(), ready);
      assert.equal(dom.intervals.size, 1);
      assert.equal(dom.listeners.filter((type) => type === 'visibilitychange').length, 1);
      assert.equal(dom.timers.size, 0);
      for (const request of dom.requests) {
        assert.equal(request.path, path);
        assert.equal(request.options.method, 'POST');
        assert.equal(request.options.headers['X-Handoff-Capability'], drop.capability);
        assert.equal(request.options.body, undefined);
      }
      for (const element of dom.node('check-failed').children.concat([...['check-note', 'check-retry'].map(dom.node)])) {
        assert.equal(element.textContent.includes(drop.capability), false);
        if (drop.key) assert.equal(element.textContent.includes(drop.key), false);
      }
      const after = snapshot(drop);
      assert.equal(after.state, before.state);
      if (direction === 'outbound') {
        assert.equal(after.attemptsRemaining, 3);
        assert.equal(after.claimed, false);
        assert.equal(after.hasCiphertext, true);
      }
    });
  }

  it(`${direction}: repeated failure stays retryable; late timed-out answer cannot repaint success`, async () => {
    const drop = await mint();
    let late;
    const dom = await loadMetadataPage(drop.hash, broker.baseUrl, (url, options) => new Promise((resolve) => {
      late = () => resolve(realFetch(url, options));
    }));
    [...dom.timers.values()].find(({ ms }) => ms === 20_000)?.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dom.state(), 'check-failed');
    dom.transport(faults[503]);
    await dom.retry();
    assert.equal(dom.state(), 'check-failed');
    assert.equal(dom.node('check-retry').textContent, 'Retry');
    late();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(dom.state(), 'check-failed');
    dom.transport(null);
    await dom.retry();
    assert.equal(dom.state(), ready);
  });

  for (const status of [400, 403, 404, 410]) {
    it(`${direction}: Retry to ${status} is terminal unavailable`, async () => {
      const drop = await mint();
      const dom = await loadMetadataPage(drop.hash, broker.baseUrl, faults[503]);
      assert.equal(dom.state(), 'check-failed');
      dom.transport(() => Promise.resolve(new Response('', { status })));
      await dom.retry();
      assert.equal(dom.state(), 'unavailable');
      assert.equal(dom.node('check-failed').hidden, true);
      assert.equal(dom.intervals.size, 0);
    });
  }
}
