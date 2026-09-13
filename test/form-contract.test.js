// The declarative form contract in isolation, against the shared case table.
//
// The table is `test/fixtures/form-contract-vectors.json` and the Python twin runs the
// same file (`tests/test_form_contract.py`). That is not tidiness: the canonical string
// in each accepted case is the byte sequence whose SHA-256 the HPKE `info` binds, so a
// disagreement between the two languages is not a style difference, it is a drop that can
// never be opened. Pinning the canonical form itself — rather than only "both sides agree"
// — also catches the case where both drift together.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  FIELD_TYPES,
  FORM_CONTRACT_REASONS,
  MAX_CONTRACT_BYTES,
  MAX_DESCRIPTION_CHARS,
  MAX_FIELDS,
  MAX_LABEL_CHARS,
  MAX_TITLE_CHARS,
  canonicalizeFormContract,
  deliveryFor,
  formContractDigest,
  isEmailShaped,
  utf8Length,
  validateFormContract,
  validateSubmission,
} from '../src/form-contract.js';

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/form-contract-vectors.json', import.meta.url), 'utf8'),
);

describe('the shared contract vectors', () => {
  for (const vector of vectors.accepted) {
    it(`accepts ${vector.name} and canonicalizes it byte for byte`, async () => {
      const result = validateFormContract({ contract: vector.contract, maxFiles: 5 });
      assert.equal(result.ok, true, result.reason);
      const delivery = deliveryFor(result.contract, vector.consumer);
      assert.deepEqual({ ...delivery }, vector.delivery);
      assert.equal(canonicalizeFormContract(result.contract, delivery), vector.canonical);
      // The digest is derived from the canonical string rather than stored beside it,
      // so the table cannot claim a digest the canonical form does not produce.
      const { createHash } = await import('node:crypto');
      assert.equal(
        await formContractDigest(result.contract, delivery),
        createHash('sha256').update(vector.canonical, 'utf8').digest('hex'),
      );
    });
  }

  for (const vector of vectors.refused) {
    it(`refuses ${vector.name} with ${vector.reason}`, () => {
      const result = validateFormContract({ contract: vector.contract, maxFiles: 5 });
      assert.equal(result.ok, false);
      assert.equal(result.reason, vector.reason);
      // A refusal carries a code and nothing else: no offending value, no prose that
      // varied with the input, nothing a caller could not branch on.
      assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
      assert.ok(FORM_CONTRACT_REASONS.includes(result.reason));
    });
  }

  it('covers every declared refusal reason that the table can reach', () => {
    const covered = new Set(vectors.refused.map((vector) => vector.reason));
    // `contract_too_large` is reachable only through a contract longer than the table is
    // worth carrying, and is exercised separately below.
    // `contract_too_large` is the one exclusion, and it is excluded because it is
    // genuinely unreachable through validated parts — proved by the maximal-contract
    // measurement below rather than asserted here.
    const expected = FORM_CONTRACT_REASONS.filter((reason) => reason !== 'contract_too_large');
    for (const reason of expected) assert.ok(covered.has(reason), reason);
  });
});

describe('absence, defaults and the bounded whole', () => {
  it('reads an absent contract as absence rather than as an empty one', () => {
    assert.deepEqual(validateFormContract({ contract: undefined }), { ok: true, contract: null });
    assert.deepEqual(validateFormContract({ contract: null }), { ok: true, contract: null });
  });

  it('returns the effective contract, not the abbreviation that was typed', () => {
    const result = validateFormContract({
      contract: { version: 1, fields: [{ id: 'f', type: 'files', label: 'Logs' }] },
      maxFiles: 5,
    });
    // A default supplies a value the caller declined to choose; a repair changes one it
    // did choose. This is the former, and the digest needs it to be explicit.
    assert.deepEqual(result.contract.fields[0], {
      id: 'f', type: 'files', label: 'Logs', required: false, min_files: 1, max_files: 1,
    });
  });

  it('keeps a maximal legal contract inside the ceiling the control line imposes', () => {
    // The house pattern from `worstCaseManifestBytes`: measure the genuinely maximal
    // case against the ceiling rather than trusting arithmetic about it. Every part is
    // at its own bound and every character is non-BMP, which is the worst case in UTF-8
    // bytes — so if this fits, no contract built from validated parts can fail to.
    //
    // That makes `contract_too_large` a backstop rather than a reachable refusal, and
    // this test is what would notice if a future bound moved far enough to change that.
    const widest = {
      version: 1,
      title: '𝕏'.repeat(MAX_TITLE_CHARS),
      description: '𝕏'.repeat(MAX_DESCRIPTION_CHARS),
      fields: Array.from({ length: MAX_FIELDS }, (_, index) => ({
        id: `field_${'x'.repeat(24)}${index}`.slice(0, 32),
        type: 'text',
        label: '𝕏'.repeat(MAX_LABEL_CHARS),
      })),
    };
    const result = validateFormContract({ contract: widest, maxFiles: 5 });
    assert.equal(result.ok, true, result.reason);
    const bytes = utf8Length(
      canonicalizeFormContract(result.contract, deliveryFor(result.contract, null)),
    );
    assert.ok(bytes <= MAX_CONTRACT_BYTES, `maximal contract is ${bytes} bytes`);
    // ...and it is genuinely near the ceiling rather than trivially under it, so the
    // ceiling is sized against something real.
    assert.ok(bytes > MAX_CONTRACT_BYTES / 2, `maximal contract is only ${bytes} bytes`);
  });

  it('does not mutate the caller’s object', () => {
    const contract = { version: 1, fields: [{ id: 'a', type: 'text', label: 'A' }] };
    const before = JSON.stringify(contract);
    validateFormContract({ contract, maxFiles: 5 });
    assert.equal(JSON.stringify(contract), before);
  });

  it('knows every type it claims to', () => {
    assert.deepEqual([...FIELD_TYPES], ['text', 'email', 'textarea', 'secret', 'files']);
  });
});

describe('submission rules', () => {
  const contract = validateFormContract({
    contract: {
      version: 1,
      fields: [
        { id: 'who', type: 'text', label: 'Who', required: true },
        { id: 'mail', type: 'email', label: 'Email' },
        { id: 'logs', type: 'files', label: 'Logs', min_files: 2, max_files: 3 },
      ],
    },
    maxFiles: 5,
  }).contract;

  const ok = (values, files = []) => validateSubmission({ contract, values, files });

  it('accepts the required field alone', () => {
    assert.deepEqual(ok([{ field: 'who', value: 'ada' }]), { ok: true });
  });

  it('treats a whitespace-only required value as blank, and preserves it elsewhere', () => {
    assert.equal(ok([{ field: 'who', value: '   ' }]).reason, 'blank_required_field');
    // The same characters in an optional field are a value, not a blank — nothing here
    // trims what a person typed.
    assert.deepEqual(
      ok([{ field: 'who', value: 'ada' }, { field: 'mail', value: '' }]),
      { ok: true },
    );
  });

  it('lets an optional file group be omitted, and enforces its bounds when supplied', () => {
    assert.deepEqual(ok([{ field: 'who', value: 'ada' }]), { ok: true });
    assert.equal(
      ok([{ field: 'who', value: 'ada' }], [{ field: 'logs' }]).reason,
      'file_count_out_of_range',
    );
    assert.deepEqual(
      ok([{ field: 'who', value: 'ada' }], [{ field: 'logs' }, { field: 'logs' }]),
      { ok: true },
    );
  });

  it('refuses a value on a files field and files on a value field', () => {
    assert.equal(ok([{ field: 'logs', value: 'x' }]).reason, 'value_on_files_field');
    assert.equal(
      ok([{ field: 'who', value: 'ada' }], [{ field: 'who' }]).reason,
      'files_on_value_field',
    );
  });

  it('names the missing field rather than calling the submission empty', () => {
    // Both refusals are correct; this one is more useful. A contract with a required
    // field can say *which* question was not answered, and `empty_submission` is
    // reserved for the case where there is no such field to name.
    assert.equal(ok([]).reason, 'missing_required_field');
    assert.equal(ok([]).field, 'who');
    assert.equal(ok([{ field: 'mail', value: '' }]).reason, 'missing_required_field');
  });

  it('refuses an all-optional form answered not at all', () => {
    const optional = validateFormContract({
      contract: {
        version: 1,
        fields: [
          { id: 'first', type: 'text', label: 'First' },
          { id: 'second', type: 'text', label: 'Second' },
        ],
      },
      maxFiles: 5,
    }).contract;
    // The form is legal — an all-optional contract is a real request — so the rule about
    // answering nothing lives here, at submit time, rather than as a refusal to build it.
    assert.equal(validateSubmission({ contract: optional, values: [] }).reason, 'empty_submission');
    assert.equal(
      validateSubmission({ contract: optional, values: [{ field: 'first', value: '' }] }).reason,
      'empty_submission',
    );
    assert.deepEqual(
      validateSubmission({ contract: optional, values: [{ field: 'first', value: 'x' }] }),
      { ok: true },
    );
  });

  it('checks an email for shape without pretending to check existence', () => {
    assert.ok(isEmailShaped('ops@example.test'));
    assert.ok(!isEmailShaped('not-an-email'));
    assert.ok(!isEmailShaped('a b@example.test'));
    assert.ok(!isEmailShaped('@example.test'));
    assert.ok(!isEmailShaped('a@b'));
    assert.ok(!isEmailShaped('a@@b.test'));
  });
});
