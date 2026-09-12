// The form descriptor: the optional, bounded, non-secret copy a requester may attach
// to an inbound drop so the page can say what it is asking for.
//
// Two properties are pinned here, and both are load-bearing for a reason that is not
// about this module's own correctness.
//
// The first is that nothing is silently repaired. A descriptor is composed by a model
// and rendered to a person, so a value that breaks a rule has to come back as a
// refusal the model can act on rather than as a quietly different string: "  " is not
// a space, a clamped exact count is a lie about what was asked for, and a key the
// schema does not name is a caller that believes something this schema does not do.
// `outbound_payload` makes the same argument about credentials; this is the same rule
// applied to copy.
//
// The second is that the bounds are counted in *code points*. A user writing
// Ukrainian, or anything outside the BMP, must not silently get half the allowance of
// a user writing ASCII — which is exactly what counting UTF-16 units would do.
//
// The Python twin of this table lives in
// integrations/hermes-drop/tests/test_form_request.py. The two must agree case for
// case: the plugin refuses before a drop exists, the broker refuses authoritatively,
// and a rule only one of them enforces is a rule a caller meets inconsistently.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FORM_REFUSAL_REASONS,
  MAX_DESCRIPTION_CHARS,
  MAX_LABEL_CHARS,
  validateFormRequest,
} from '../src/form-request.js';

/** The shape every call in this file uses, so a case only states what it varies. */
const check = (form, { payloadKind = 'files', maxFiles = 5 } = {}) =>
  validateFormRequest({ form, payloadKind, maxFiles });

describe('form descriptor: absence', () => {
  it('accepts an absent descriptor and produces nothing to render', () => {
    // The backward-compatible path. Every existing caller takes it, and it must not
    // manufacture an empty object for the metadata response to carry.
    for (const absent of [undefined, null]) {
      const result = check(absent, { payloadKind: 'universal' });
      assert.equal(result.ok, true);
      assert.equal(result.form, null);
    }
  });

  it('refuses a descriptor that says nothing', () => {
    // `{}` is not "no descriptor" — it is a caller that built one and filled in
    // nothing, which is a mistake worth hearing about rather than a default.
    assert.deepEqual(check({}), { ok: false, reason: 'empty_form' });
  });

  it('refuses a descriptor that is not an object', () => {
    for (const bad of ['a label', 42, true, [], () => {}]) {
      assert.equal(check(bad).ok, false, `accepted ${typeof bad}`);
      assert.equal(check(bad).reason, 'not_an_object');
    }
  });
});

describe('form descriptor: keys', () => {
  it('refuses a key the schema does not name', () => {
    // Same discipline as outbound_payload's `unknown_key`: a caller sending a field
    // this schema does not implement believes something about the form that is not
    // true, and ignoring it lets that belief survive.
    assert.deepEqual(check({ label: 'Staging config', html: '<b>x</b>' }), {
      ok: false,
      reason: 'unknown_key',
    });
    assert.equal(check({ title: 'Staging config' }).reason, 'unknown_key');
  });

  it('keeps every refusal reason inside the published set', () => {
    // The reason travels to a model as a tool result and from there into durable
    // state, so the vocabulary is closed and carries no input.
    const seen = [
      check(''), check({}), check({ nope: 1 }),
      check({ label: '' }), check({ label: 'x'.repeat(MAX_LABEL_CHARS + 1) }),
      check({ description: '\u202e' }),
      check({ description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1) }),
      check({ expect_files: 0 }),
      check({ expect_files: 2 }, { payloadKind: 'text' }),
      check({ expect_files: 9 }),
    ];
    for (const result of seen) {
      assert.equal(result.ok, false);
      assert.ok(
        FORM_REFUSAL_REASONS.includes(result.reason),
        `undeclared reason: ${result.reason}`,
      );
      // Never the offending input, at any length.
      assert.match(result.reason, /^[a-z_]+$/);
    }
  });
});

describe('form descriptor: label and description text rules', () => {
  it('accepts ordinary copy, in any script', () => {
    const result = check({
      label: 'Staging deployment config',
      description: 'Upload the two configuration files for the staging deployment.',
    });
    assert.equal(result.ok, true);
    assert.equal(result.form.label, 'Staging deployment config');

    // The model may write in the conversation's language; only the static UI chrome
    // is English. Cyrillic is letters as far as every rule here is concerned.
    const ukrainian = check({ description: 'Вставте токен доступу до стейджингу.' });
    assert.equal(ukrainian.ok, true);
    assert.equal(ukrainian.form.description, 'Вставте токен доступу до стейджингу.');
  });

  it('counts the bound in code points, not UTF-16 units', () => {
    // The property that makes the bound fair. An astral character is two UTF-16
    // units and one code point, so counting units would give a user writing emoji
    // — or any non-BMP script — half the allowance.
    const astral = '🙂';
    assert.equal(astral.length, 2, 'precondition: this character is a surrogate pair');
    assert.equal([...astral].length, 1);

    const exactly = `a${astral.repeat(MAX_LABEL_CHARS - 1)}`;
    assert.equal([...exactly].length, MAX_LABEL_CHARS);
    assert.equal(check({ label: exactly }).ok, true, 'exactly at the bound is allowed');

    const oneOver = `a${astral.repeat(MAX_LABEL_CHARS)}`;
    assert.deepEqual(check({ label: oneOver }), { ok: false, reason: 'label_too_long' });
  });

  it('refuses at one code point past each bound', () => {
    assert.equal(check({ label: 'a'.repeat(MAX_LABEL_CHARS) }).ok, true);
    assert.equal(check({ label: 'a'.repeat(MAX_LABEL_CHARS + 1) }).reason, 'label_too_long');
    assert.equal(check({ description: 'a'.repeat(MAX_DESCRIPTION_CHARS) }).ok, true);
    assert.equal(
      check({ description: 'a'.repeat(MAX_DESCRIPTION_CHARS + 1) }).reason,
      'description_too_long',
    );
  });

  it('refuses a bidi override, which is copy that can lie about itself', () => {
    // The load-bearing half of the forbidden set. A description that can reverse its
    // own rendering can make one sentence read as another beside the input a person
    // is about to paste a credential into.
    //
    // Written as escapes rather than as the characters themselves, deliberately: a
    // reader has to be able to see what a case contains, and an invisible character
    // sitting in a source file is one an editor, a diff or a paste can silently drop
    // -- which would leave the case passing while testing nothing.
    const RLO = '\u202e'; // RIGHT-TO-LEFT OVERRIDE
    const RLE = '\u202b'; // RIGHT-TO-LEFT EMBEDDING
    const RLM = '\u200f'; // RIGHT-TO-LEFT MARK
    for (const hostile of [`${RLO}eslaf`, `Paste the${RLE} token`, `a${RLM}b`]) {
      assert.equal(check({ description: `Upload ${hostile}` }).ok, false);
    }
    assert.equal(check({ label: `Staging${RLO}config` }).reason, 'bad_label');
  });

  it('refuses control characters and line breaks', () => {
    // Single-paragraph copy only: a newline in the description is a layout the page
    // never has to survive, and keeping it out is what makes the two-language rule
    // trivial to state.
    const bad = [
      'Upload\nboth files', // LINE FEED
      'Upload\tboth',       // TAB
      'Upload\u000bboth',     // VERTICAL TAB
      'a\u0000b',            // NUL
      'Upload\u2028both',     // LINE SEPARATOR      (Zl)
      'Upload\u2029both',     // PARAGRAPH SEPARATOR (Zp)
      'Upload\u200bboth',     // ZERO WIDTH SPACE    (Cf)
    ];
    for (const value of bad) {
      const result = check({ description: value });
      assert.equal(result.ok, false, `accepted ${JSON.stringify(value)}`);
      assert.equal(result.reason, 'bad_description');
    }
  });

  it('refuses exotic whitespace, padding and double spaces rather than repairing them', () => {
    // Not normalised -- refused. A collapsed string is a different string from the one
    // the caller composed, and the caller is entitled to find out rather than to have
    // it quietly repaired here and differently somewhere else.
    const NBSP = '\u00a0';
    assert.equal(check({ label: `Staging${NBSP}config` }).reason, 'bad_label', 'non-breaking space');
    assert.equal(check({ label: ' Staging config' }).reason, 'bad_label', 'leading space');
    assert.equal(check({ label: 'Staging config ' }).reason, 'bad_label', 'trailing space');
    assert.equal(check({ label: 'Staging  config' }).reason, 'bad_label', 'double space');
  });

  it('refuses copy that says nothing', () => {
    for (const empty of ['', '   ', '...', '—']) {
      assert.equal(check({ label: empty }).ok, false, `accepted ${JSON.stringify(empty)}`);
    }
  });

  it('refuses a non-string label or description', () => {
    assert.equal(check({ label: 42 }).reason, 'bad_label');
    assert.equal(check({ description: ['a'] }).reason, 'bad_description');
    assert.equal(check({ description: null }).reason, 'bad_description');
  });

  it('renders hostile markup as nothing more than characters to carry', () => {
    // The descriptor is display data. Markup is not *refused* — it is meaningless
    // here, because the page writes textContent and builds no node from it — so the
    // validator's job is only to pass the characters through unchanged.
    const hostile = '<img src=x onerror=alert(1)> please paste it';
    const result = check({ description: hostile });
    assert.equal(result.ok, true);
    assert.equal(result.form.description, hostile, 'not escaped, not stripped, not altered');
  });
});

describe('form descriptor: expect_files', () => {
  it('accepts an exact count inside the drop’s own ceiling', () => {
    const result = check({ expect_files: 2 }, { payloadKind: 'files', maxFiles: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.form.expect_files, 2);
  });

  it('is meaningful only on a files drop', () => {
    // Exactness is a claim about a request whose shape is known. A universal drop is
    // by definition one whose shape is not, and a text drop has no file lane at all —
    // so both refuse rather than ignore, exactly as `max_files` already does on text.
    assert.deepEqual(check({ expect_files: 2 }, { payloadKind: 'text' }), {
      ok: false,
      reason: 'expect_files_not_allowed',
    });
    assert.equal(
      check({ expect_files: 2 }, { payloadKind: 'universal' }).reason,
      'expect_files_not_allowed',
    );
  });

  it('refuses a count above the ceiling rather than clamping it', () => {
    // `max_files` may narrow silently because it is an upper bound and narrowing one
    // stays true. An *exact* count that were clamped would be a different request
    // from the one that was made, and both the user and the model would be told
    // something that is not so.
    assert.deepEqual(check({ expect_files: 9 }, { maxFiles: 5 }), {
      ok: false,
      reason: 'expect_files_too_large',
    });
    assert.equal(check({ expect_files: 3 }, { maxFiles: 2 }).reason, 'expect_files_too_large');
    assert.equal(check({ expect_files: 2 }, { maxFiles: 2 }).ok, true, 'exactly at the ceiling');
  });

  it('refuses a count that is not a usable whole number', () => {
    for (const bad of [0, -1, 1.5, '2', true, NaN, Infinity, null]) {
      const result = check({ expect_files: bad });
      assert.equal(result.ok, false, `accepted ${JSON.stringify(bad)}`);
      assert.equal(result.reason, 'bad_expect_files');
    }
  });

  it('leaves the upper bound alone when no exact count is asked for', () => {
    // No expectation means the drop's existing ceiling, which the page renders as
    // "up to N files". It must not invent an exactness nobody stated.
    const result = check({ description: 'Upload whatever the deploy needs.' });
    assert.equal(result.ok, true);
    assert.equal('expect_files' in result.form, false);
  });
});

describe('form descriptor: the accepted value', () => {
  it('carries through exactly the keys that were given', () => {
    const result = check({ label: 'Staging config', expect_files: 2 });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.form).sort(), ['expect_files', 'label']);
  });
});
