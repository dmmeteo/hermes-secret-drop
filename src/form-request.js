// The inbound form descriptor: what a requester may say about the input it is asking
// for, so the page can say it too.
//
// A drop link has always rendered the same page — a textarea, a file picker, and copy
// that could not name the thing being requested. The person opening it had to go back
// to the conversation to find out what to paste. This module is the schema for the
// small, bounded, NON-SECRET answer to that: an optional label, an optional short
// description, and an optional exact file count.
//
// Three properties are worth stating because the rest of the file is their
// consequence.
//
// **It is display data, and it is untrusted.** Every string here is composed by a
// model and rendered to a person. The page writes it with `textContent` into static
// markup and builds no node from it, so markup in a description renders as those
// characters — but that is a defence against *execution*, not against *meaning*.
// Copy can still mislead, which is what the bounds, the closed key set and the model
// guidance are for. Nothing here is a credential and nothing here is secret.
//
// **Nothing is silently repaired.** A value that breaks a rule comes back as a
// refusal, never as a quietly different string. `outbound_payload` makes this argument
// about credentials — a trimmed password is a login failure whose cause is invisible —
// and it holds just as well for copy: a collapsed double space is not what the caller
// wrote, and a clamped exact count is a different request from the one that was made.
//
// **The mode is not here.** Whether a drop wants text, files or either is
// `payload_kind`, which this protocol already has and already binds into the AEAD
// (`src/broker.js`, `resolveSubmitKind`). This module only describes the request; it
// never decides the lane, and `expect_files` is refused outright on a kind that has no
// file lane rather than ignored.
//
// The Python twin is `integrations/hermes-drop/drop/form_request.py`, which refuses
// before a drop exists; this side is the authority. A rule only one of them enforces
// is a rule a caller meets inconsistently, so the two are held to one case table
// (`test/form-request.test.js`, `tests/test_form_request.py`).
import { displayTextProblem } from './outbound-payload.js';

/**
 * The descriptor revision this broker speaks, advertised as `form_protocol` on the
 * `create` response.
 *
 * It exists for the same pre-flight reason as `file_claim_protocol`: the two halves of
 * this project ship together but are *installed* separately, so a plugin that means
 * "exactly two files, and here is why" must be able to find out that it is talking to
 * a broker which will enforce that — BEFORE it posts a link. A broker without this
 * field would accept the `form` key by ignoring it, render the old generic page, and
 * take any file count at all; the descriptor would be silently dropped and the user
 * would be asked the wrong question. Absence means "cannot", never "probably fine".
 */
export const FORM_PROTOCOL = 1;

/** A heading for the form: short enough to stay one line on a phone. */
export const MAX_LABEL_CHARS = 80;

/**
 * One or two sentences saying what to paste — not a security essay, and not a place
 * to restate what the page already says about encryption or expiry. The ceiling is
 * what keeps it quiet copy rather than a second document.
 */
export const MAX_DESCRIPTION_CHARS = 300;

/** The closed key set. Anything else is a caller that believes something untrue. */
export const FORM_KEYS = Object.freeze(['label', 'description', 'expect_files']);

/**
 * The closed refusal vocabulary.
 *
 * Codes, never prose, and never the offending input — for the reason
 * `outbound_payload.reasons` gives: a refusal is a tool result, it reaches the model's
 * context, and from there durable session state. A reason that quoted the value would
 * put the caller's string somewhere it was never meant to go, and a reason that varied
 * with the input would be one no caller could branch on.
 */
export const FORM_REFUSAL_REASONS = Object.freeze([
  'not_an_object',
  'empty_form',
  'unknown_key',
  'bad_label',
  'label_too_long',
  'bad_description',
  'description_too_long',
  'bad_expect_files',
  'expect_files_not_allowed',
  'expect_files_too_large',
]);

function refuse(reason) {
  // Unreachable except by editing this module: every call site passes a literal or a
  // value mapped from `displayTextProblem`. A reason outside the published set would
  // reach a caller with no branch for it, so it is a defect here rather than something
  // to forward.
  if (!FORM_REFUSAL_REASONS.includes(reason)) {
    throw new Error(`undeclared refusal reason: ${reason}`);
  }
  return { ok: false, reason };
}

/** `null` for an absent descriptor; a plain object or a refusal for anything else. */
function shapeOf(form) {
  // `undefined` and `null` are both absence — the backward-compatible path every
  // existing caller takes, and the one that must not manufacture an empty object for
  // the metadata response to carry.
  if (form === undefined || form === null) return null;
  // An array is an object to `typeof`, and a function is not; neither is a descriptor.
  if (typeof form !== 'object' || Array.isArray(form)) return refuse('not_an_object');
  return form;
}

/**
 * Validates one form descriptor against the drop it is being minted for.
 *
 * `payloadKind` and `maxFiles` are the drop's own — already validated by the caller —
 * because two of the rules here are about the *pair* rather than about the descriptor
 * alone: an exact count means nothing without a file lane to count in, and it cannot
 * be honoured above a ceiling the drop will not accept.
 *
 * Returns `{ ok: true, form }` where `form` is `null` for an absent descriptor and
 * otherwise carries exactly the keys that were given, or `{ ok: false, reason }`.
 * Never throws for caller input, never mutates its argument, and never returns a
 * value the caller did not write.
 */
export function validateFormRequest({ form, payloadKind, maxFiles } = {}) {
  const shape = shapeOf(form);
  if (shape === null) return { ok: true, form: null };
  if (shape.ok === false) return shape;

  const keys = Object.keys(shape);
  // `{}` is not absence: it is a caller that built a descriptor and filled in nothing,
  // which is a mistake worth hearing about rather than a default to swallow.
  if (keys.length === 0) return refuse('empty_form');
  for (const key of keys) {
    if (!FORM_KEYS.includes(key)) return refuse('unknown_key');
  }

  const accepted = {};

  if ('label' in shape) {
    const problem = displayTextProblem(shape.label, MAX_LABEL_CHARS);
    if (problem === 'too_long') return refuse('label_too_long');
    if (problem) return refuse('bad_label');
    accepted.label = shape.label;
  }

  if ('description' in shape) {
    const problem = displayTextProblem(shape.description, MAX_DESCRIPTION_CHARS);
    if (problem === 'too_long') return refuse('description_too_long');
    if (problem) return refuse('bad_description');
    accepted.description = shape.description;
  }

  if ('expect_files' in shape) {
    const expected = shape.expect_files;
    // `true` is an integer to `Number.isInteger`? No — but it is to a `==` comparison,
    // and a boolean reaching a count field is a caller mistake either way. Checked
    // explicitly so the type is never coerced into a plausible 1.
    if (typeof expected === 'boolean' || !Number.isInteger(expected) || expected < 1) {
      return refuse('bad_expect_files');
    }
    // Exactness is a claim about a request whose shape is known. A `universal` drop is
    // by definition one whose shape is not — the sender still chooses the lane — and a
    // `text` drop has no file lane at all. Both are refused rather than ignored, on
    // exactly the terms `max_files` is already refused on a text drop: a caller that
    // asked for a file count and got something else was misheard.
    if (payloadKind !== 'files') return refuse('expect_files_not_allowed');
    // Refused, not clamped. `max_files` may narrow silently because it is an upper
    // bound and a narrowed upper bound is still true; an exact count that were clamped
    // would be a different request from the one that was made, and both the user and
    // the model would be told something that is not so.
    if (typeof maxFiles === 'number' && expected > maxFiles) {
      return refuse('expect_files_too_large');
    }
    accepted.expect_files = expected;
  }

  return { ok: true, form: accepted };
}
