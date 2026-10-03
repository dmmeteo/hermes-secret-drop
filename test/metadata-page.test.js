// The full production page entry point at its fetch seam. Complements (and does
// not replace) the same-link/live-broker and real-browser checks.
import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { SUITE_ID } from '../src/hpke-suite.js';
import { OUTBOUND_ALG } from '../src/outbound-envelope.js';
import { loadMetadataPage } from './helpers/metadata-page.js';

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.window;
  delete globalThis.document;
});
const capability = 'A'.repeat(22);
const key = 'A'.repeat(43);
for (const direction of ['inbound', 'outbound']) {
  const hash = direction === 'inbound' ? `#${capability}` : `#r.${capability}.${key}`;
  const ready = direction === 'inbound' ? 'form' : 'reveal';
  const good = () => new Response(JSON.stringify({
    v: 1, suite: SUITE_ID, hid: capability, pk: Buffer.alloc(65).toString('base64url'), payload_kind: 'text',
    max_plaintext_bytes: 65536, expires_at: Date.now() + 120000, now: Date.now(),
    alg: OUTBOUND_ALG, did: capability, attempts_remaining: 3, code_length: 3,
  }));
  for (const failure of ['network', '503', 'malformed', 'headers-hang', 'body-hang']) {
    it(`${direction} page: ${failure}, duplicate Retry, recovery and timer cleanup`, async () => {
      let late;
      const fault = () => {
        if (failure === 'network') return Promise.reject(new TypeError('synthetic'));
        if (failure === '503') return Promise.resolve(new Response('', { status: 503 }));
        if (failure === 'malformed') return Promise.resolve(new Response('invalid json'));
        const pending = new Promise(resolve => { late = resolve; });
        return failure === 'body-hang' ? Promise.resolve({ ok: true, json: () => pending }) : pending;
      };
      const dom = await loadMetadataPage(hash, 'https://drop.invalid', fault);
      if (failure.includes('hang')) {
        const deadline = [...dom.timers.values()].find(({ ms }) => ms === 20000);
        assert.ok(deadline);
        deadline.fn();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(dom.requests[0].options.signal.aborted, true);
      }
      assert.equal(dom.state(), 'check-failed');
      assert.equal(dom.node('check-retry').textContent, 'Retry');
      let release;
      dom.transport(() => new Promise(resolve => { release = () => resolve(good()); }));
      const retry = dom.retry();
      await dom.retry();
      assert.equal(dom.requests.length, 2);
      assert.equal(dom.node('check-retry').textContent, 'Checking…');
      assert.equal(dom.node('check-retry').attributes.get('aria-disabled'), 'true');
      release();
      await retry;
      assert.equal(dom.state(), ready);
      assert.equal(dom.intervals.size, 1);
      assert.equal(dom.timers.size, 0);
      assert.equal(dom.listeners.filter(type => type === 'visibilitychange').length, 1);
      if (late) {
        late(failure === 'body-hang' ? {} : new Response('', { status: 404 }));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(dom.state(), ready, 'late old failure cannot replace success');
      }
      await dom.retry();
      assert.equal(dom.requests.length, 2, 'finished initialization cannot restart');
      assert.ok(dom.requests.every(({ path, options }) =>
        path === (direction === 'inbound' ? '/api/metadata' : '/api/reveal/metadata') &&
        options.headers['X-Handoff-Capability'] === capability && options.body === undefined));
    });
  }
  it(`${direction} page: repeated failure, then unavailable, cannot restart`, async () => {
    const dom = await loadMetadataPage(hash, 'https://drop.invalid', async () => new Response('', { status: 503 }));
    await dom.retry();
    assert.equal(dom.state(), 'check-failed');
    dom.transport(async () => new Response('', { status: 404 }));
    await dom.retry();
    assert.equal(dom.state(), 'unavailable');
    await dom.retry();
    assert.equal(dom.requests.length, 3);
    assert.equal(dom.intervals.size, 0);
    assert.equal(dom.timers.size, 0);
  });
}
