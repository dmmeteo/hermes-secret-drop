// The declarative form contract: an ordered list of fields a requester may ask for, and
// the single bounded vocabulary the page, the broker and the plugin all read it through.
//
// Drop used to ask for exactly one private thing — a textarea, a file picker, or both —
// and the page could not name what it wanted. `src/form-request.js` widened that to a
// heading, a sentence and an exact file count. This module is the next and last widening
// the product plan calls for: a *combination* of fields, each with a stable id, a concrete
// label and a standard type, so a requester can ask for a username and a password, or a
// release tag and two independent groups of log files, without Drop growing a preset for
// each shape.
//
// Four properties carry the rest of the file.
//
// **Composition, not presets.** There is no "login form" and no "API key form". There are
// five field types and an order, and every shape the product needs is a combination of
// them. A type is added here only when no combination expresses it — which is why the set
// is small and why it is closed.
//
// **The id is the identity; the label is display.** Values come back keyed by id, so an id
// is a stable machine name (`^[a-z][a-z0-9_]{0,31}$`) and must be unique. A *label* is what
// a person reads, it is untrusted display data, and it is deliberately NOT required to be
// unique: two independently identified file groups may honestly both be captioned "Log
// files", and refusing that would be an outbound-specific rule imported for no reason.
//
// **Delivery is derived, never chosen.** Whether a submission goes to the model or to an
// authorized no-model consumer follows from the field types alone (`deliveryFor`). No
// argument anywhere selects a result type, so no argument can downgrade masking by asking
// for a public one. The derived delivery block is part of the canonical contract and
// therefore part of the digest bound into the AEAD.
//
// **Nothing is silently repaired.** A value that breaks a rule is refused, never quietly
// rewritten — the argument `outbound_payload` makes about credentials, which holds just as
// well for copy. Defaults are a different thing and are filled in explicitly: an absent
// `required` *means* false and an absent `max_files` *means* one, so the effective contract
// this module returns carries them as numbers and booleans. Determinism needs the effective
// contract, not the abbreviation the caller typed.
//
// The Python twin is `integrations/hermes-drop/drop/form_contract.py`. A rule only one of
// them enforces is a rule a caller meets inconsistently, so the two are held to one shared
// case table and to byte-identical canonicalization (`test/form-contract.test.js`,
// `tests/test_form_contract.py`).
import { displayTextProblem } from './outbound-payload.js';

/**
 * The descriptor revision this broker speaks, advertised as `form_protocol` on `create`.
 *
 * 2, because 1 was the `label`/`description`/`expect_files` descriptor and this revision
 * changes what the key accepts. It exists for the same pre-flight reason as
 * `file_claim_protocol`: the two halves of this project ship together but are *installed*
 * separately, so a plugin that means "a username and a password, and here is why" must be
 * able to find out that it is talking to a broker which will enforce that BEFORE it posts a
 * link. A broker on 1 would accept a `form` key it reads differently, render the wrong
 * page, and ask the user the wrong question. Absence means "cannot", never "probably fine".
 */
export const FORM_PROTOCOL = 2;

/** The contract revision. A change to the shape raises this rather than reusing it. */
export const FORM_CONTRACT_VERSION = 1;

/**
 * How many fields one form may carry.
 *
 * Eight, the same as `MAX_FIELDS` on the outbound payload and for the same reason: it is
 * comfortably more than any real request — a login is two, a deploy is five — and it is
 * what keeps the canonical whole inside `MAX_CONTRACT_BYTES` for labels of a useful size
 * rather than only for tiny ones.
 */
export const MAX_FIELDS = 8;

/** Form heading width, in code points. Matches the outbound title. */
export const MAX_TITLE_CHARS = 60;

/** Field label width, in code points. Long enough for "OPENROUTER_API_KEY". */
export const MAX_LABEL_CHARS = 40;

/** One or two sentences saying what to supply; not a second document. */
export const MAX_DESCRIPTION_CHARS = 300;

/** Field id width, in characters. The pattern below bounds it too; both are stated. */
export const MAX_FIELD_ID_CHARS = 32;

/**
 * The id grammar.
 *
 * Lowercase ASCII, digits and underscore, starting with a letter. This is not style: it is
 * what makes a dangerous object key unreachable by construction rather than by a filter.
 * `__proto__` cannot match (it starts with `_`), and neither can anything with a capital.
 * `constructor` and `prototype` *do* match, so they are denied by name below — and the wire
 * format never keys an object by a field id at all (see `src/file-container.js`, HDROP3),
 * so this is the second of two independent reasons a hostile id cannot reach a prototype.
 */
export const FIELD_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Ids that match the grammar but name something on `Object.prototype`. */
export const DENIED_FIELD_IDS = Object.freeze(['constructor', 'prototype']);

/**
 * The closed type set.
 *
 *   text      — one line, shown normally. A username, an account id, a release tag.
 *   email     — one line, shown normally, checked for an @ with something either side.
 *   textarea  — several lines, shown normally. Notes, a config fragment, a public key.
 *   secret    — one line, masked, with an accessible reveal. A password, a token, a key.
 *   files     — one independently identified group of files, with its own count bounds.
 */
export const FIELD_TYPES = Object.freeze(['text', 'email', 'textarea', 'secret', 'files']);

/** The types whose value the page masks, and which force a consumer (see `deliveryFor`). */
export const SECRET_FIELD_TYPES = Object.freeze(['secret']);

/** The types that carry one UTF-8 string rather than a group of files. */
export const VALUE_FIELD_TYPES = Object.freeze(['text', 'email', 'textarea', 'secret']);

/**
 * Per-value ceilings, in UTF-8 *bytes* — the unit the wire and the AEAD count in.
 *
 * `text`/`email` match the outbound `MAX_VALUE_BYTES`. `textarea` is larger because an SSH
 * public key or a small config fragment is a legitimate answer. `secret` sits between them:
 * larger than a password needs, smaller than a document, because a secret this size is
 * almost always something that should have been a file.
 */
export const MAX_VALUE_BYTES = Object.freeze({
  text: 512,
  email: 512,
  textarea: 8192,
  secret: 4096,
});

/** Files per group. The *sum* of every group's `max_files` is bounded by the drop's own. */
export const MAX_FILES_PER_FIELD = 5;

/**
 * Canonical contract ceiling, in UTF-8 bytes.
 *
 * Sized against the control protocol, not taste: the whole `create` request line is bounded
 * at 4096 bytes (`src/control-server.js`) and the contract travels inside it. Bounding the
 * parts alone is how a contract every field of which is legal gets built and then cannot be
 * sent. Eight fields at their maxima come to roughly 1.1 KiB, so this ceiling is a backstop
 * that a realistic contract never meets — which is the point: it is here for the adversarial
 * contract, not the ordinary one.
 */
export const MAX_CONTRACT_BYTES = 4096;

/** How deep the contract JSON may nest. The shape is flat; anything deeper is not it. */
export const MAX_CONTRACT_DEPTH = 8;

/** The closed key set for the contract itself. */
export const CONTRACT_KEYS = Object.freeze(['version', 'title', 'description', 'fields']);

/** The keys every field carries, and the two more a `files` field may. */
export const FIELD_KEYS = Object.freeze(['id', 'type', 'label', 'required']);
export const FILE_FIELD_KEYS = Object.freeze(['id', 'type', 'label', 'required', 'min_files', 'max_files']);

/**
 * The closed refusal vocabulary.
 *
 * Codes, never prose, and never the offending input — for the reason
 * `outbound_payload.reasons` gives: a refusal is a tool result, it reaches the model's
 * context and from there durable session state. A reason quoting the value would put the
 * caller's string somewhere it was never meant to go, and a reason that varied with the
 * input is one no caller could branch on.
 */
export const FORM_CONTRACT_REASONS = Object.freeze([
  'bad_description',
  'bad_field',
  'bad_field_id',
  'bad_files_bounds',
  'bad_label',
  'bad_required',
  'bad_title',
  'bad_type',
  'bad_version',
  'contract_too_large',
  'denied_field_id',
  'description_too_long',
  'duplicate_field_id',
  'files_over_budget',
  'label_too_long',
  'no_fields',
  'not_an_object',
  'title_too_long',
  'too_many_fields',
  'unknown_key',
]);

const encoder = new TextEncoder();

function refuse(reason) {
  // Unreachable except by editing this module: every call site passes a literal. A reason
  // outside the published set would reach a caller with no branch for it, so it is a defect
  // here rather than something to forward.
  if (!FORM_CONTRACT_REASONS.includes(reason)) {
    throw new Error(`undeclared refusal reason: ${reason}`);
  }
  return { ok: false, reason };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exact own-key match. An unknown or missing key is malformed, not a key to ignore. */
function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Every key present must be known, and every required key must be present. */
function keysWithin(value, required, optional) {
  if (!isPlainObject(value)) return false;
  const own = Object.keys(value);
  const known = [...required, ...optional];
  if (!own.every((key) => known.includes(key))) return false;
  return required.every((key) => Object.hasOwn(value, key));
}

export function utf8Length(value) {
  return encoder.encode(value).length;
}

/** `true`/`false` only. A truthy string or a 1 is a caller mistake, not a boolean. */
function isBoolean(value) {
  return value === true || value === false;
}

/** A whole number in range, with `-0` and booleans excluded so there is one spelling. */
function isCount(value, min, max) {
  if (typeof value === 'boolean') return false;
  return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max;
}

/** The masked types, as a predicate, so no caller re-derives the list. */
export function isSecretFieldType(type) {
  return SECRET_FIELD_TYPES.includes(type);
}

/** True when any field forces the no-model consumer boundary. */
export function hasSecretField(contract) {
  return contract.fields.some((field) => isSecretFieldType(field.type));
}

/**
 * The delivery contract, derived from the field types alone.
 *
 * This is the whole of the "a tool argument must not be able to downgrade the restriction
 * by choosing a public result type" rule: there is no argument. A form containing a secret
 * goes to an authorized consumer or it is not minted; a form containing none takes the
 * ordinary Hermes path. The result is part of the canonical contract, so it is bound into
 * the AEAD along with the fields it was derived from.
 */
export function deliveryFor(contract, consumerName = null) {
  if (!hasSecretField(contract)) return Object.freeze({ mode: 'model', consumer: null });
  return Object.freeze({ mode: 'consumer', consumer: consumerName });
}

/** Depth guard, run before anything walks the structure. */
function depthOf(value, depth = 1) {
  if (depth > MAX_CONTRACT_DEPTH) return depth;
  if (Array.isArray(value)) {
    let deepest = depth;
    for (const item of value) deepest = Math.max(deepest, depthOf(item, depth + 1));
    return deepest;
  }
  if (isPlainObject(value)) {
    let deepest = depth;
    for (const key of Object.keys(value)) deepest = Math.max(deepest, depthOf(value[key], depth + 1));
    return deepest;
  }
  return depth;
}

function validateField(raw, { seen }) {
  if (!isPlainObject(raw)) return refuse('bad_field');

  // The type is read first because it decides which key set applies. A `text` field
  // carrying `min_files` is a caller that believes something untrue about it, and is
  // refused rather than tidied up.
  const type = raw.type;
  if (typeof type !== 'string' || !FIELD_TYPES.includes(type)) return refuse('bad_type');
  const isFiles = type === 'files';
  if (!keysWithin(raw, ['id', 'type', 'label'], isFiles ? ['required', 'min_files', 'max_files'] : ['required'])) {
    return refuse('unknown_key');
  }

  const id = raw.id;
  if (typeof id !== 'string' || !FIELD_ID_PATTERN.test(id)) return refuse('bad_field_id');
  if (DENIED_FIELD_IDS.includes(id)) return refuse('denied_field_id');
  // Uniqueness is on the id and only on the id. Two groups captioned "Log files" are a
  // legitimate form; two fields both called `logs` are an ambiguous one.
  if (seen.has(id)) return refuse('duplicate_field_id');
  seen.add(id);

  const labelProblem = displayTextProblem(raw.label, MAX_LABEL_CHARS);
  if (labelProblem === 'too_long') return refuse('label_too_long');
  if (labelProblem) return refuse('bad_label');

  // Absent means optional. Filled in explicitly rather than left undefined, because the
  // canonical form has to be the *effective* contract for the digest to mean anything.
  let required = false;
  if (Object.hasOwn(raw, 'required')) {
    if (!isBoolean(raw.required)) return refuse('bad_required');
    required = raw.required;
  }

  const field = { id, type, label: raw.label, required };
  if (!isFiles) return { ok: true, field };

  // One file unless the caller says otherwise: the commonest ask, and a default that can
  // never silently admit more than was intended.
  let minFiles = 1;
  let maxFiles = 1;
  if (Object.hasOwn(raw, 'max_files')) {
    if (!isCount(raw.max_files, 1, MAX_FILES_PER_FIELD)) return refuse('bad_files_bounds');
    maxFiles = raw.max_files;
  }
  if (Object.hasOwn(raw, 'min_files')) {
    if (!isCount(raw.min_files, 1, MAX_FILES_PER_FIELD)) return refuse('bad_files_bounds');
    minFiles = raw.min_files;
  } else if (maxFiles < minFiles) {
    // `max_files: 0` cannot happen, so this only fires when a caller set `max_files` below
    // the default minimum of one — which means one file, not none.
    minFiles = maxFiles;
  }
  if (minFiles > maxFiles) return refuse('bad_files_bounds');

  return { ok: true, field: { ...field, min_files: minFiles, max_files: maxFiles } };
}

/**
 * Validates one form contract against the drop it is being minted for.
 *
 * `maxFiles` is the drop's own effective ceiling, already validated by the caller, because
 * one rule is about the pair rather than the contract alone: the file groups together
 * cannot ask for more files than the drop will accept.
 *
 * Returns `{ ok: true, contract }` where `contract` is the **effective** contract — every
 * default filled in, key order fixed, nothing the caller wrote altered — or
 * `{ ok: false, reason }`. Never throws for caller input and never mutates its argument.
 */
export function validateFormContract({ contract, maxFiles } = {}) {
  if (contract === undefined || contract === null) return { ok: true, contract: null };
  if (!isPlainObject(contract)) return refuse('not_an_object');
  // Checked before the walk: a hostile structure must cost a depth probe, not a traversal.
  if (depthOf(contract) > MAX_CONTRACT_DEPTH) return refuse('unknown_key');

  if (!keysWithin(contract, ['version', 'fields'], ['title', 'description'])) {
    return refuse('unknown_key');
  }
  if (contract.version !== FORM_CONTRACT_VERSION) return refuse('bad_version');

  const accepted = { version: FORM_CONTRACT_VERSION };

  if (Object.hasOwn(contract, 'title')) {
    const problem = displayTextProblem(contract.title, MAX_TITLE_CHARS);
    if (problem === 'too_long') return refuse('title_too_long');
    if (problem) return refuse('bad_title');
    accepted.title = contract.title;
  }

  if (Object.hasOwn(contract, 'description')) {
    const problem = displayTextProblem(contract.description, MAX_DESCRIPTION_CHARS);
    if (problem === 'too_long') return refuse('description_too_long');
    if (problem) return refuse('bad_description');
    accepted.description = contract.description;
  }

  const fields = contract.fields;
  if (!Array.isArray(fields)) return refuse('bad_field');
  if (fields.length === 0) return refuse('no_fields');
  if (fields.length > MAX_FIELDS) return refuse('too_many_fields');

  const seen = new Set();
  const out = [];
  for (const raw of fields) {
    const result = validateField(raw, { seen });
    if (result.ok === false) return result;
    out.push(result.field);
  }
  accepted.fields = out;

  // An all-optional form is legal. What an empty *submission* means is defined at submit
  // time (`validateSubmission`), not by refusing to build the form — a form of optional
  // questions is a real thing to ask, and refusing it would be the engine deciding for the
  // requester what a reasonable request looks like.

  const budget = typeof maxFiles === 'number' ? maxFiles : MAX_FILES_PER_FIELD;
  const asked = out.reduce((sum, field) => sum + (field.type === 'files' ? field.max_files : 0), 0);
  if (asked > budget) return refuse('files_over_budget');

  // Bound the whole, not only the parts: a contract every field of which is legal must
  // still fit the control line it has to travel inside.
  if (utf8Length(canonicalizeFormContract(accepted, deliveryFor(accepted, null))) > MAX_CONTRACT_BYTES) {
    return refuse('contract_too_large');
  }

  return { ok: true, contract: accepted };
}

/**
 * The exact bytes the digest is taken over.
 *
 * Hand-built in a fixed key order rather than serialized from the object, for the reason
 * `canonicalizeOutboundPayload` gives: determinism is the whole job, and a JSON serializer
 * that reordered a key would silently change an identity that is bound into the AEAD. Both
 * languages build this string the same way and the suite holds them to byte equality over a
 * shared fixture table including non-BMP Unicode, combining marks and booleans.
 *
 * An absent `title` or `description` is absent from the canonical form — not present as
 * `null` — so "no description" has exactly one spelling.
 */
export function canonicalizeFormContract(contract, delivery) {
  const parts = [`{"version":${JSON.stringify(contract.version)}`];
  if (Object.hasOwn(contract, 'title')) parts.push(`,"title":${JSON.stringify(contract.title)}`);
  if (Object.hasOwn(contract, 'description')) parts.push(`,"description":${JSON.stringify(contract.description)}`);
  parts.push(',"fields":[');
  parts.push(contract.fields.map((field) => {
    const head = `{"id":${JSON.stringify(field.id)},"type":${JSON.stringify(field.type)}` +
      `,"label":${JSON.stringify(field.label)},"required":${field.required ? 'true' : 'false'}`;
    if (field.type !== 'files') return `${head}}`;
    return `${head},"min_files":${field.min_files},"max_files":${field.max_files}}`;
  }).join(','));
  parts.push(']');
  parts.push(`,"delivery":{"mode":${JSON.stringify(delivery.mode)},"consumer":` +
    `${delivery.consumer === null ? 'null' : JSON.stringify(delivery.consumer)}}}`);
  return parts.join('');
}

/** SHA-256 of the canonical contract, lowercase hex. The identity bound into `info`. */
export async function formContractDigest(contract, delivery) {
  const bytes = encoder.encode(canonicalizeFormContract(contract, delivery));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Lowercase hex, fixed width — the only digest spelling anything here accepts. */
export const CONTRACT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * An email is checked for shape, not for existence.
 *
 * One `@`, something either side, no whitespace, and a dot in the domain. Deliberately not
 * RFC 5322: a stricter pattern rejects addresses that work, and a looser one accepts a
 * paragraph. This is the same check the page makes, which is why it lives here rather than
 * in the browser bundle.
 */
export function isEmailShaped(value) {
  if (typeof value !== 'string') return false;
  if (/\s/u.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/** Every reason a *submission* can be refused against a contract it was built for. */
export const SUBMISSION_REASONS = Object.freeze([
  'blank_required_field',
  'duplicate_submitted_field',
  'empty_submission',
  'file_count_out_of_range',
  'files_on_value_field',
  'missing_required_field',
  'not_email_shaped',
  'unknown_submitted_field',
  'value_on_files_field',
  'value_too_long',
]);

function refuseSubmission(reason, field) {
  if (!SUBMISSION_REASONS.includes(reason)) {
    throw new Error(`undeclared submission reason: ${reason}`);
  }
  return { ok: false, reason, field: field ?? null };
}

/**
 * Validates a submission against the contract it claims to answer.
 *
 * `values` is an **ordered array** of `{ field, value }` and `files` an ordered array of
 * `{ field, ... }` — never an object keyed by id, on the wire or here. That is what makes a
 * hostile id structurally unable to reach a prototype rather than filtered out of one.
 *
 * Shared by the page and the broker so that what the sender is told and what the broker
 * enforces cannot drift. The page's copy is a convenience and is evidence of nothing; the
 * broker's is authoritative, and runs on the decoded plaintext after the AEAD has opened.
 *
 * Whitespace inside a value is preserved exactly. Validation never trims, collapses or
 * normalises what a person typed — a password of three spaces is three spaces — and the
 * only thing whitespace decides is whether a *required* field counts as blank.
 */
export function validateSubmission({ contract, values = [], files = [] }) {
  const byId = new Map(contract.fields.map((field) => [field.id, field]));
  const seen = new Set();

  for (const entry of values) {
    const field = byId.get(entry.field);
    if (field === undefined) return refuseSubmission('unknown_submitted_field', entry.field);
    if (seen.has(entry.field)) return refuseSubmission('duplicate_submitted_field', entry.field);
    seen.add(entry.field);
    if (field.type === 'files') return refuseSubmission('value_on_files_field', entry.field);
    if (utf8Length(entry.value) > MAX_VALUE_BYTES[field.type]) {
      return refuseSubmission('value_too_long', entry.field);
    }
    // Shape, then blankness: an email that is only spaces is blank, not malformed, and the
    // message a person gets should say the thing they can act on.
    if (field.required && entry.value.trim() === '') {
      return refuseSubmission('blank_required_field', entry.field);
    }
    if (field.type === 'email' && entry.value !== '' && !isEmailShaped(entry.value)) {
      return refuseSubmission('not_email_shaped', entry.field);
    }
  }

  const counts = new Map();
  for (const entry of files) {
    const field = byId.get(entry.field);
    if (field === undefined) return refuseSubmission('unknown_submitted_field', entry.field);
    if (field.type !== 'files') return refuseSubmission('files_on_value_field', entry.field);
    counts.set(entry.field, (counts.get(entry.field) ?? 0) + 1);
    seen.add(entry.field);
  }

  for (const field of contract.fields) {
    const count = counts.get(field.id) ?? 0;
    if (field.type === 'files') {
      // An optional group may be left out entirely; one that is supplied at all must satisfy
      // its own bounds. A required group must be there.
      if (count === 0) {
        if (field.required) return refuseSubmission('missing_required_field', field.id);
        continue;
      }
      if (count < field.min_files || count > field.max_files) {
        return refuseSubmission('file_count_out_of_range', field.id);
      }
      continue;
    }
    if (field.required && !seen.has(field.id)) {
      return refuseSubmission('missing_required_field', field.id);
    }
  }

  // Defined here rather than by refusing an all-optional contract: a form of optional
  // questions is a real request, but pressing Send having answered none of it is not a
  // submission — it is an empty one, and it would consume a one-shot drop for nothing.
  const anyValue = values.some((entry) => entry.value !== '');
  if (!anyValue && files.length === 0) return refuseSubmission('empty_submission', null);

  return { ok: true };
}
