// The form descriptor across the seams it actually crosses: minted on the control
// socket, echoed to the page that holds the capability, and enforced at submit.
//
// `test/form-request.test.js` pins the schema in isolation. This file pins the
// things that are only true end to end, and each of them is a property a
// frontend-only implementation would appear to have while not having it:
//
//   - a descriptor that breaks a rule mints NOTHING. The refusal has to arrive
//     before a handoff exists, because there is no destroy op to take one back and a
//     caller holding a link to a form it cannot render is worse off than one holding
//     a refusal;
//   - the exact file count is enforced on the DECODED CONTAINER by the broker. The
//     page's own count gate is a convenience for the sender and is not evidence of
//     anything — the real count is inside the ciphertext until the broker opens it;
//   - a wrong count does not CONSUME the drop. An honest sender who picked the wrong
//     number must be able to try again, or the feature would turn a typo into a lost
//     drop;
//   - and a drop minted without a descriptor answers byte-identically to how it
//     always did, because that is every caller that predates this.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createFileDrop, createUniversalDrop, splitHandoffUrl, startTestBroker } from './helpers/harness.js';
import { fetchMetadata } from '../src/client/handoff-client.js';

// A broker per test, not per file. A `files` drop reserves its whole advertised
// total against the process-wide live-file budget for as long as it stays pending,
// and that budget holds four of them -- so a file-drop test that shared a broker with
// its neighbours would start failing on the fifth one for a reason that has nothing
// to do with what it is testing.
let broker;
beforeEach(async () => { broker = await startTestBroker(); });
afterEach(async () => { await broker.stop(); });

/** One file of `size` bytes, filled with a byte that depends on the index. */
const fileLike = (index, size = 8) => ({
  name: `part-${index}.conf`,
  type: 'text/plain',
  bytes: Uint8Array.from({ length: size }, () => index + 1),
});

describe('the descriptor reaches the page, and only the page that holds the capability', () => {
  it('echoes exactly what was minted', async () => {
    const drop = await createFileDrop(broker, {
      maxFiles: 5,
      form: {
        label: 'Staging deployment config',
        description: 'Upload the two configuration files for the staging deployment.',
        expect_files: 2,
      },
    });
    assert.equal(drop.created.ok, true);
    assert.deepEqual(drop.metadata.form, {
      label: 'Staging deployment config',
      description: 'Upload the two configuration files for the staging deployment.',
      expect_files: 2,
    });
    // The kind is what carries the mode; the descriptor never restates it.
    assert.equal(drop.metadata.payload_kind, 'files');
    assert.equal(drop.metadata.max_files, 5, 'the upper bound is still advertised');
  });

  it('advertises the capability on the create response', async () => {
    // The pre-flight field. A client that means "exactly two files" has to be able to
    // learn, before it posts a link, that it is talking to a broker which will
    // enforce that rather than ignore it.
    const drop = await createUniversalDrop(broker);
    // 2 since the declarative contract landed. The number is a floor, not an exact
    // match, and this descriptor's own floor is still 1 — which is exactly why a legacy
    // client reading `form_protocol >= 1` keeps working against this broker.
    assert.equal(drop.created.form_protocol, 2);
  });

  it('carries no form key at all when none was asked for', async () => {
    // The backward-compatible answer, and the reason it is an absent key rather than
    // an empty object: a page must be able to tell "no descriptor" from "a descriptor
    // that says nothing" without a sentinel.
    const drop = await createUniversalDrop(broker);
    assert.equal('form' in drop.metadata, false);
  });

  it('is not served to a caller without the capability', async () => {
    // The descriptor is display data, but it is still this drop's display data: it
    // says what a named person is being asked for, and it rides the same
    // capability-authorized response as every other field. A wrong capability gets
    // the uniform body, not a descriptor.
    const drop = await createFileDrop(broker, { form: { label: 'Staging config' } });
    assert.equal(drop.metadata.form.label, 'Staging config');

    const wrong = 'A'.repeat(splitHandoffUrl(drop.created.url).capability.length);
    assert.equal(await fetchMetadata({ capability: wrong, origin: broker.baseUrl }), null);
  });
});

describe('an invalid descriptor mints nothing', () => {
  /** Every refusal here must cost a refusal and no handoff. */
  const refuses = async (request) => {
    const answer = await broker.control({ op: 'create', ttl_seconds: 120, ...request });
    assert.equal(answer.ok, false, `accepted ${JSON.stringify(request)}`);
    assert.equal(answer.error, 'invalid_request');
    assert.equal(answer.handoff_id, undefined, 'a handoff was minted on the way to a refusal');
    assert.equal(answer.url, undefined);
    return answer;
  };

  it('refuses an over-long description before minting', async () => {
    const answer = await refuses({
      payload_kind: 'universal',
      form: { description: 'a'.repeat(301) },
    });
    assert.equal(answer.reason, 'description_too_long');
  });

  it('refuses an over-long label before minting', async () => {
    const answer = await refuses({ payload_kind: 'universal', form: { label: 'a'.repeat(81) } });
    assert.equal(answer.reason, 'label_too_long');
  });

  it('refuses a key the schema does not name', async () => {
    const answer = await refuses({ payload_kind: 'universal', form: { heading: 'x' } });
    assert.equal(answer.reason, 'unknown_key');
  });

  it('refuses an exact count on a kind with no file lane', async () => {
    // Refused rather than ignored, on the same terms `max_files` already is on a text
    // drop: a caller that asked for a file count and got something else was misheard
    // about the only thing it was asked.
    assert.equal((await refuses({ form: { expect_files: 2 } })).reason, 'expect_files_not_allowed');
    assert.equal(
      (await refuses({ payload_kind: 'universal', form: { expect_files: 2 } })).reason,
      'expect_files_not_allowed',
    );
  });

  it('refuses an exact count above the drop’s own ceiling rather than clamping it', async () => {
    // `max_files` narrows silently because a narrowed upper bound is still true. An
    // exact count cannot: clamped, it would be a different request from the one made.
    const answer = await refuses({
      payload_kind: 'files',
      max_files: 2,
      form: { expect_files: 3 },
    });
    assert.equal(answer.reason, 'expect_files_too_large');
  });

  it('reports a code and never the offending string', async () => {
    // The refusal travels to a plugin, from there to a model, and from there into
    // durable session state. It must not carry the caller's copy.
    const secretish = 'CORRECT-HORSE-BATTERY-STAPLE';
    const answer = await refuses({
      payload_kind: 'universal',
      form: { label: `${secretish}  ${secretish}` }, // double space: refused
    });
    assert.equal(answer.reason, 'bad_label');
    assert.equal(JSON.stringify(answer).includes(secretish), false);
  });
});

describe('the exact count is enforced where the count actually exists', () => {
  it('refuses the wrong number of files without consuming the drop, then accepts the right one', async () => {
    const drop = await createFileDrop(broker, { maxFiles: 5, form: { expect_files: 2 } });

    // Three files, sealed and submitted through the production client path. The page
    // would not have offered this, which is exactly why it is worth testing: the
    // browser gate is not the enforcement.
    const tooMany = await drop.send(await drop.seal([fileLike(0), fileLike(1), fileLike(2)]));
    assert.equal(tooMany, 'unavailable');

    const tooFew = await drop.send(await drop.seal([fileLike(0)]));
    assert.equal(tooFew, 'unavailable');

    // Nothing was consumed: the drop is still pending and still answers metadata.
    const still = await fetchMetadata({ capability: drop.capability, origin: broker.baseUrl });
    assert.equal(still.form.expect_files, 2, 'the drop lapsed on a count mistake');

    // And the correct count still wins.
    assert.equal(await drop.send(await drop.seal([fileLike(0), fileLike(1)])), 'received');
  });

  it('accepts any count inside the ceiling when no exact count was asked for', async () => {
    // No expectation means the drop's existing upper bound. It must not become an
    // exactness nobody stated.
    const drop = await createFileDrop(broker, { maxFiles: 5, form: { label: 'Deploy files' } });
    assert.equal(await drop.send(await drop.seal([fileLike(0), fileLike(1), fileLike(2)])), 'received');
  });

  it('charges the wrong count against the drop’s own failure budget', async () => {
    // Reaching the count check costs a full HPKE open and a SHA-256 pass over the
    // container, so an authenticated caller must not be able to buy it without limit.
    // It is charged to the same counter a refused container is, and the drop is
    // destroyed once the budget is spent -- which is a bounded refusal, not a
    // consumed payload.
    const drop = await createFileDrop(broker, { maxFiles: 5, form: { expect_files: 2 } });
    const budget = broker.config.maxAeadFailures;

    for (let attempt = 0; attempt < budget; attempt += 1) {
      assert.equal(await drop.send(await drop.seal([fileLike(attempt)])), 'unavailable');
    }

    // Spent: the drop is gone, and the correct count no longer helps.
    assert.equal(await fetchMetadata({ capability: drop.capability, origin: broker.baseUrl }), null);
  });
});

describe('a drop minted without a descriptor is unchanged', () => {
  it('still accepts text and files on a universal link', async () => {
    // The regression that matters most: every existing caller passes no descriptor,
    // and both lanes of the form that ships today must behave exactly as before.
    const text = await createUniversalDrop(broker);
    assert.equal('form' in text.metadata, false);
    assert.equal(await text.send(await text.sealText('a private value')), 'received');

    const files = await createUniversalDrop(broker);
    assert.equal(await files.send(await files.sealFiles([fileLike(0), fileLike(1)])), 'received');
  });
});
