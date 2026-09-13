// The declarative form engine, end to end through the seams a browser and a plugin
// actually reach: mint on the control socket, metadata over HTTP, a container sealed by
// the production client, and the claim that hands the values back.
//
// Nothing here reaches into the broker's internals. A test that asserted on a record field
// would pass while the thing a user meets was broken, which is the failure mode
// CONTRIBUTING is guarding against when it says to test at the seam an attacker reaches.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startTestBroker, createFormDrop, createUniversalDrop } from './helpers/harness.js';

const CREDENTIAL_PAIR = {
  version: 1,
  title: 'Staging console sign-in',
  description: 'Use the staging account, not your personal one.',
  fields: [
    { id: 'username', type: 'text', label: 'Username', required: true },
    { id: 'password', type: 'secret', label: 'Password', required: true },
  ],
};

const NAMED_API_KEY = {
  version: 1,
  title: 'OpenRouter API key',
  fields: [{ id: 'api_key', type: 'secret', label: 'OPENROUTER_API_KEY', required: true }],
};

const MIXED_NON_SECRET = {
  version: 1,
  title: 'Deployment evidence',
  fields: [
    { id: 'release', type: 'text', label: 'Release tag', required: true },
    { id: 'contact', type: 'email', label: 'Email', required: false },
    { id: 'notes', type: 'textarea', label: 'Notes', required: false },
  ],
};

describe('a form drop carries an ordered contract to the page', () => {
  let broker;
  before(async () => { broker = await startTestBroker(); });
  after(async () => { await broker.stop(); });

  it('publishes the contract, its identity and the lane it must be sealed in', async () => {
    const drop = await createFormDrop(broker, { contract: MIXED_NON_SECRET });
    assert.equal(drop.created.ok, true);
    assert.equal(drop.created.payload_kind, 'form');
    assert.equal(drop.created.delivery_mode, 'model');
    assert.match(drop.created.contract_digest, /^[0-9a-f]{64}$/);

    // `fetchMetadata` returns null unless it re-derived this digest itself from the
    // contract it was served, so a non-null metadata here is already proof the page and
    // the broker agree about the identity.
    assert.notEqual(drop.metadata, null);
    assert.equal(drop.metadata.contract_digest, drop.created.contract_digest);
    assert.equal(drop.metadata.v, 3);
    assert.deepEqual(drop.metadata.envelope_versions, { form: 3 });
    assert.deepEqual(drop.metadata.delivery, { mode: 'model', consumer: null });
    assert.deepEqual(
      drop.metadata.form_contract.fields.map((field) => field.id),
      ['release', 'contact', 'notes'],
    );
    // The effective contract, with the defaults filled in: absent `required` is false.
    assert.equal(drop.metadata.form_contract.fields[1].required, false);
  });

  it('round-trips every value byte-exactly, keyed by its stable id', async () => {
    const drop = await createFormDrop(broker, { contract: MIXED_NON_SECRET });
    const values = [
      { field: 'release', value: 'v2026.9.13' },
      { field: 'contact', value: 'ops@example.test' },
      { field: 'notes', value: 'line one\nline two — ключ 🔑' },
    ];
    assert.equal(await drop.send(await drop.seal({ values })), 'received');

    const claimed = await broker.control({ op: 'claim', handoff_id: drop.id });
    assert.equal(claimed.ok, true);
    assert.deepEqual(claimed.form.values, values);
    assert.equal(claimed.form.contract_digest, drop.created.contract_digest);
    assert.deepEqual(claimed.form.delivery, { mode: 'model', consumer: null });
  });

  it('preserves whitespace inside a value exactly as it was typed', async () => {
    const drop = await createFormDrop(broker, { contract: MIXED_NON_SECRET });
    const values = [{ field: 'release', value: '  v1  ' }, { field: 'notes', value: '\t \n' }];
    assert.equal(await drop.send(await drop.seal({ values })), 'received');
    const claimed = await broker.control({ op: 'claim', handoff_id: drop.id });
    assert.deepEqual(claimed.form.values, values);
  });

  it('refuses a second claim, exactly like every other drop', async () => {
    const drop = await createFormDrop(broker, { contract: MIXED_NON_SECRET });
    await drop.send(await drop.seal({ values: [{ field: 'release', value: 'v1' }] }));
    assert.equal((await broker.control({ op: 'claim', handoff_id: drop.id })).ok, true);
    assert.deepEqual(
      await broker.control({ op: 'claim', handoff_id: drop.id }),
      { ok: false, error: 'unavailable' },
    );
  });
});

describe('the contract is the authority on what may be submitted', () => {
  let broker;
  before(async () => { broker = await startTestBroker(); });
  after(async () => { await broker.stop(); });

  // Each case seals a container the page would never build, submits it through the real
  // HTTP seam, and asserts the drop is still claimable afterwards — the refusal must cost
  // the sender nothing, so an honest person who typed the wrong thing can simply try again.
  const rejected = [
    ['an unknown field id', [{ field: 'nope', value: 'x' }]],
    ['a duplicate field id', [{ field: 'release', value: 'a' }, { field: 'release', value: 'b' }]],
    ['a missing required field', [{ field: 'notes', value: 'only the optional one' }]],
    ['a required field that is only whitespace', [{ field: 'release', value: '   ' }]],
    ['an email that is not email-shaped', [
      { field: 'release', value: 'v1' },
      { field: 'contact', value: 'not-an-email' },
    ]],
    ['an over-long value', [{ field: 'release', value: 'v'.repeat(513) }]],
    ['nothing at all', []],
  ];

  for (const [name, values] of rejected) {
    it(`refuses ${name} without consuming the drop`, async () => {
      const drop = await createFormDrop(broker, { contract: MIXED_NON_SECRET });
      assert.equal(await drop.send(await drop.seal({ values })), 'unavailable');
      // Still pending: a correct submission still wins.
      assert.equal(
        await drop.send(await drop.seal({ values: [{ field: 'release', value: 'v1' }] })),
        'received',
      );
      const claimed = await broker.control({ op: 'claim', handoff_id: drop.id });
      assert.equal(claimed.ok, true);
      assert.deepEqual(claimed.form.values, [{ field: 'release', value: 'v1' }]);
    });
  }

  it('accepts an all-optional form answered in part, and refuses it answered not at all', async () => {
    const contract = {
      version: 1,
      fields: [
        { id: 'first', type: 'text', label: 'First' },
        { id: 'second', type: 'text', label: 'Second' },
      ],
    };
    const empty = await createFormDrop(broker, { contract });
    assert.equal(await empty.send(await empty.seal({ values: [] })), 'unavailable');

    const answered = await createFormDrop(broker, { contract });
    assert.equal(
      await answered.send(await answered.seal({ values: [{ field: 'second', value: 'only this' }] })),
      'received',
    );
    const claimed = await broker.control({ op: 'claim', handoff_id: answered.id });
    assert.deepEqual(claimed.form.values, [{ field: 'second', value: 'only this' }]);
  });
});

describe('the contract is bound into the ciphertext', () => {
  let broker;
  before(async () => { broker = await startTestBroker(); });
  after(async () => { await broker.stop(); });

  it('refuses a container sealed under a tampered contract, and consumes nothing', async () => {
    const drop = await createFormDrop(broker, { contract: MIXED_NON_SECRET });

    // The page is lied to: the label it renders, and therefore the identity it seals
    // under, is not the one the broker stored. This is the descriptor-tampering case the
    // digest exists for, and it has to fail at the AEAD rather than produce a form that
    // quietly asked a different question.
    const tampered = structuredClone(drop.metadata);
    tampered.form_contract.fields[0].label = 'Production release tag';
    const { formContractDigest, deliveryFor } = await import('../src/form-contract.js');
    tampered.contract_digest = await formContractDigest(
      tampered.form_contract,
      deliveryFor(tampered.form_contract, null),
    );
    assert.notEqual(tampered.contract_digest, drop.metadata.contract_digest);

    const { sealFormEnvelope } = await import('../src/client/handoff-client.js');
    const envelope = await sealFormEnvelope({
      capability: drop.capability,
      metadata: tampered,
      values: [{ field: 'release', value: 'v1' }],
    });
    assert.equal(await drop.send(envelope), 'unavailable');

    // Nothing was consumed: an honest submission still wins.
    assert.equal(
      await drop.send(await drop.seal({ values: [{ field: 'release', value: 'v1' }] })),
      'received',
    );
  });

  it('will not let a form container be replayed at a universal link', async () => {
    const universal = await createUniversalDrop(broker);
    const form = await createFormDrop(broker, { contract: MIXED_NON_SECRET });
    const envelope = await form.seal({ values: [{ field: 'release', value: 'v1' }] });
    const response = await fetch(`${broker.baseUrl}/api/submit`, {
      method: 'POST',
      headers: {
        'x-handoff-capability': universal.capability,
        'content-type': 'application/json',
        'x-handoff-payload': 'form',
      },
      body: JSON.stringify(envelope),
    });
    assert.equal(response.ok, false);
  });
});

describe('a secret field forces the consumer boundary at mint', () => {
  let broker;
  before(async () => { broker = await startTestBroker(); });
  after(async () => { await broker.stop(); });

  it('refuses to mint a secret-bearing contract with no consumer to bind', async () => {
    const refused = await broker.control({
      op: 'create', payload_kind: 'form', ttl_seconds: 60, form_contract: CREDENTIAL_PAIR,
    });
    assert.deepEqual(refused, {
      ok: false, error: 'invalid_request', reason: 'secret_needs_consumer',
    });
  });

  it('binds the consumer name into the identity, so two consumers are two contracts', async () => {
    const one = await createFormDrop(broker, { contract: NAMED_API_KEY, consumer: 'canary' });
    const two = await createFormDrop(broker, { contract: NAMED_API_KEY, consumer: 'other' });
    assert.equal(one.created.delivery_mode, 'consumer');
    assert.notEqual(one.created.contract_digest, two.created.contract_digest);
    assert.deepEqual(one.metadata.delivery, { mode: 'consumer', consumer: 'canary' });
  });

  it('delivers a secret form through the same lane, still keyed by id', async () => {
    const drop = await createFormDrop(broker, { contract: CREDENTIAL_PAIR, consumer: 'canary' });
    const values = [
      { field: 'username', value: 'ada' },
      { field: 'password', value: 'correct horse battery staple' },
    ];
    assert.equal(await drop.send(await drop.seal({ values })), 'received');
    const claimed = await broker.control({ op: 'claim', handoff_id: drop.id });
    assert.deepEqual(claimed.form.values, values);
    // The broker does not decide who may see this; it reports the contract it bound, and
    // the plugin is what refuses to hand a `consumer` payload to a model.
    assert.deepEqual(claimed.form.delivery, { mode: 'consumer', consumer: 'canary' });
  });
});

describe('the two descriptors are alternatives, never a pair', () => {
  let broker;
  before(async () => { broker = await startTestBroker(); });
  after(async () => { await broker.stop(); });

  const cases = [
    ['both descriptors at once', {
      payload_kind: 'form', form_contract: MIXED_NON_SECRET, form: { label: 'Hello' },
    }, 'form_and_legacy_descriptor'],
    ['a contract on a kind that is not a form', {
      payload_kind: 'universal', form_contract: MIXED_NON_SECRET,
    }, 'contract_needs_form_kind'],
    ['a form kind with no contract at all', { payload_kind: 'form' }, 'form_kind_needs_contract'],
  ];

  for (const [name, request, reason] of cases) {
    it(`refuses ${name}, and mints nothing`, async () => {
      const refused = await broker.control({ op: 'create', ttl_seconds: 60, ...request });
      assert.deepEqual(refused, { ok: false, error: 'invalid_request', reason });
    });
  }

  it('still mints a legacy descriptor drop exactly as it did before', async () => {
    const created = await broker.control({
      op: 'create', ttl_seconds: 60, payload_kind: 'files', max_files: 2,
      form: { label: 'Send the two logs', expect_files: 2 },
    });
    assert.equal(created.ok, true);
    assert.equal(created.payload_kind, 'files');
    assert.equal(created.form_protocol, 2);
  });
});
