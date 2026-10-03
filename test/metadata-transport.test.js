// Public fetch clients: transport refusals must not masquerade as dead links.
// No listener is needed; Response exercises the same HTTP-status/body seam.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fetchMetadata } from '../src/client/handoff-client.js';
import { fetchOutboundMetadata } from '../src/client/reveal-client.js';

for (const [name, load] of [['inbound', fetchMetadata], ['outbound', fetchOutboundMetadata]]) {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    it(`${name}: HTTP ${status} is a communication failure`, async () => {
      await assert.rejects(load({ capability: 'synthetic', fetchImpl: async () => new Response('', { status }) }));
    });
  }
  for (const status of [400, 401, 403, 404, 410]) {
    it(`${name}: HTTP ${status} remains generic unavailable`, async () => {
      assert.equal(await load({ capability: 'synthetic', fetchImpl: async () => new Response('', { status }) }), null);
    });
  }
  for (const body of ['<proxy error>', 'null', '[]']) {
    it(`${name}: malformed body is a communication failure`, async () => {
      await assert.rejects(load({ capability: 'synthetic', fetchImpl: async () => new Response(body) }));
    });
  }
  it(`${name}: incompatible metadata remains unavailable`, async () => {
    assert.equal(await load({ capability: 'synthetic', fetchImpl: async () => new Response('{}') }), null);
  });
  it(`${name}: passes abort and privacy controls only to the metadata endpoint`, async () => {
    const controller = new AbortController();
    await load({ capability: 'synthetic', signal: controller.signal, fetchImpl: async (path, options) => {
      assert.equal(path, name === 'inbound' ? '/api/metadata' : '/api/reveal/metadata');
      assert.equal(options.signal, controller.signal);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-Handoff-Capability'], 'synthetic');
      assert.equal(options.body, undefined);
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(options.cache, 'no-store');
      return new Response('', { status: 404 });
    } });
  });
}
