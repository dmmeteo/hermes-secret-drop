// The identifiers a product rename must not touch.
//
// The product's display name is Hermes Secret Drop. Several *runtime* strings still
// say `hermes-drop`, and they say it on purpose: they are bound into ciphertext or
// keyed on by installs that already exist. Each one here is a literal rather than an
// import, because the round-trip tests import the same constant on both sides and so
// would go on passing if a rename changed it — while every page and broker on the
// other side of a version boundary stopped being able to open the other's drops.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { INFO_LABEL } from '../src/hpke-suite.js';
import { outboundAad } from '../src/outbound-envelope.js';

describe('identifiers kept across the Hermes Secret Drop rename', () => {
  it('binds outbound ciphertext to the original AAD label', () => {
    const aad = new TextDecoder().decode(outboundAad('d0'));
    assert.equal(aad, 'hermes-drop/outbound/v1.d0');
  });

  it('keeps the HPKE info domain-separation label', () => {
    assert.equal(INFO_LABEL, 'hermes-handoff/v1');
  });

  it('keeps the installed plugin id', async () => {
    const manifest = await readFile(new URL('../integrations/hermes-drop/plugin.yaml', import.meta.url), 'utf8');
    assert.match(manifest, /^name: hermes-drop$/m);
  });
});
