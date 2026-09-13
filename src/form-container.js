// HDROP3 — the encrypted form container.
//
// HDROP2 carries files and one optional block of private text. A declarative form carries
// something HDROP2 has no way to say: several *named* values, and files that belong to one
// named group rather than to the drop as a whole. This is that container, and it is a
// separate codec rather than a third shape of the old one because HDROP2's manifest is
// pinned by test vectors and by a decoder that refuses any manifest it does not already
// know exactly — widening it would mean loosening that.
//
//   magic: "HDROP3" (6 bytes)
//   manifest_length: uint32 big-endian
//   manifest: UTF-8 JSON
//   payload: value bytes in manifest order, then file bytes in manifest order
//
// Everything HDROP2's header says about why this is a hand-rolled format applies here
// unchanged: it runs on attacker-supplied bytes the moment an AEAD open succeeds, so its
// whole job is to be small enough to read in one sitting. No parser to confuse, no
// decompressor to bomb, every length framed up front, every digest verified before a caller
// sees a byte.
//
// Two rules are specific to this container and are the reason it exists:
//
// **Values are an ordered ARRAY, never an object keyed by field id.** Not in the manifest,
// not in the decoded result. An id that named something on `Object.prototype` therefore has
// nowhere to land — the structure has no id-keyed object in it at all. That is a
// construction, not a filter, and it is the second of the two independent defences (the
// first being the id grammar in `src/form-contract.js`).
//
// **The contract digest travels in the manifest.** It is already bound into the HPKE `info`
// (`src/hpke-suite.js`), so a mismatch is normally fatal before this codec runs at all —
// the AEAD simply does not open. Carrying it here too costs 64 bytes and turns the
// remaining case, a broker holding a different contract than it sealed under, into a named
// local refusal (`contract_mismatch`) instead of a puzzle.
import {
  FileContainerError,
  resolveFileLimits,
  sanitizeFileName,
  sanitizeFileType,
} from './file-container.js';
import { CONTRACT_DIGEST_PATTERN, MAX_FIELDS, MAX_VALUE_BYTES, utf8Length } from './form-contract.js';

/** ASCII magic. Distinct from HDROP2, which this decoder will not accept. */
export const FORM_CONTAINER_MAGIC = 'HDROP3';

/** uint32 big-endian manifest length. */
export const MANIFEST_LENGTH_BYTES = 4;

/** magic(6) + manifest_length(4). */
export const FORM_CONTAINER_HEADER_BYTES = 10;

/**
 * Envelope version that carries a form container.
 *
 * v1 is one UTF-8 secret, v2 is HDROP2, v3 is this. The number is bound into `info`, so a
 * ciphertext sealed as one version cannot be opened as another.
 */
export const FORM_ENVELOPE_VERSION = 3;

/** The lifecycle kind of a drop whose shape is a form contract. */
export const PAYLOAD_KIND_FORM = 'form';

/**
 * Worst case for one value entry, derived rather than guessed:
 *
 *   field   32 characters, doubled to 64 for the JSON escaping that a field id can never
 *           actually need — the grammar is `[a-z0-9_]` — because a ceiling that depends on
 *           a *different* module's grammar staying narrow is a ceiling that breaks quietly
 *           when that grammar widens;
 *   size + offset  16 digits each, the widest a safe integer prints;
 *   keys, quotes, colons and braces  40 bytes.
 *
 * That is 136; 160 leaves room without pretending to be exact.
 */
const VALUE_ENTRY_CEILING_BYTES = 160;

/**
 * Worst case for one file entry: HDROP2's own 1280-byte ceiling for name, type, digest,
 * size and offset, plus the `field` key this container adds, on the same basis as above.
 */
const FILE_ENTRY_CEILING_BYTES = 1360;

/** `{"kind":"form","contract":"<64 hex>","values":[],"files":[]}` with room to spare. */
const FORM_MANIFEST_ENVELOPE_BYTES = 192;

/** The largest manifest this many fields and files can produce, separators included. */
export function worstCaseFormManifestBytes(maxFields, maxFiles) {
  return FORM_MANIFEST_ENVELOPE_BYTES +
    maxFields * (VALUE_ENTRY_CEILING_BYTES + 1) +
    maxFiles * (FILE_ENTRY_CEILING_BYTES + 1);
}

/**
 * Hard ceiling on the declared manifest length, checked before a single manifest byte is
 * decoded — so a hostile length field is refused without reference to how much was actually
 * sent, and a raised field or file count fails at startup rather than at submit time.
 */
export const MAX_FORM_MANIFEST_BYTES = worstCaseFormManifestBytes(MAX_FIELDS, 5);

/** The largest value payload a form can carry: every field at its own type's ceiling. */
const LARGEST_VALUE_CEILING = Math.max(...Object.values(MAX_VALUE_BYTES));

const SHA256_HEX = /^[0-9a-f]{64}$/;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const MAGIC_BYTES = encoder.encode(FORM_CONTAINER_MAGIC);

function refuse(code) {
  throw new FileContainerError(code);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isByteCount(value, max) {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= max;
}

async function sha256Hex(bytes) {
  let digest;
  try {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  } catch {
    refuse('digest_unavailable');
  }
  let out = '';
  for (const byte of digest) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** The largest container these limits can produce. Transports size their ceilings from it. */
export function formContainerCeiling(limits) {
  const resolved = resolveFileLimits(limits);
  return FORM_CONTAINER_HEADER_BYTES + MAX_FORM_MANIFEST_BYTES +
    MAX_FIELDS * LARGEST_VALUE_CEILING + resolved.maxTotalBytes;
}

/**
 * Builds one container from ordered `values` (`[{ field, value }]`) and ordered `files`
 * (`[{ field, name, type, bytes }]`).
 *
 * Names and MIME hints are sanitized here, so the manifest only ever carries canonical
 * values — which is exactly what `decodeFormContainer` re-checks. The value strings are
 * *not* touched: whitespace a person typed is theirs, and a container that silently trimmed
 * a password would be a login failure whose cause is invisible.
 */
export async function encodeFormContainer({ contractDigest, values = [], files = [], limits } = {}) {
  const resolved = resolveFileLimits(limits);
  if (typeof contractDigest !== 'string' || !CONTRACT_DIGEST_PATTERN.test(contractDigest)) {
    refuse('bad_contract_digest');
  }
  if (!Array.isArray(values) || !Array.isArray(files)) refuse('input_shape');
  if (values.length > MAX_FIELDS) refuse('field_count');
  if (files.length > resolved.maxFiles) refuse('file_count');

  for (const entry of values) {
    if (!isPlainObject(entry) || typeof entry.field !== 'string' || typeof entry.value !== 'string') {
      refuse('input_shape');
    }
  }
  for (const file of files) {
    if (!isPlainObject(file) || typeof file.field !== 'string' || !(file.bytes instanceof Uint8Array)) {
      refuse('input_shape');
    }
  }

  let offset = 0;
  const valueEntries = [];
  const valueBytes = [];
  for (const entry of values) {
    const bytes = encoder.encode(entry.value);
    if (bytes.length > LARGEST_VALUE_CEILING) refuse('value_size');
    // Key order is fixed so the same inputs always produce the same bytes.
    valueEntries.push({ field: entry.field, size: bytes.length, offset });
    valueBytes.push(bytes);
    offset += bytes.length;
  }

  let fileTotal = 0;
  const fileEntries = [];
  for (const file of files) {
    if (file.bytes.length > resolved.maxFileBytes) refuse('file_size');
    fileTotal += file.bytes.length;
    fileEntries.push({
      field: file.field,
      name: sanitizeFileName(file.name),
      size: file.bytes.length,
      offset,
      sha256: await sha256Hex(file.bytes),
      type: sanitizeFileType(file.type),
    });
    offset += file.bytes.length;
  }
  if (fileTotal > resolved.maxTotalBytes) refuse('total_size');

  const manifest = encoder.encode(JSON.stringify({
    kind: PAYLOAD_KIND_FORM,
    contract: contractDigest,
    values: valueEntries,
    files: fileEntries,
  }));
  if (manifest.length > MAX_FORM_MANIFEST_BYTES) refuse('manifest_length_out_of_range');

  const container = new Uint8Array(FORM_CONTAINER_HEADER_BYTES + manifest.length + offset);
  container.set(MAGIC_BYTES, 0);
  new DataView(container.buffer, container.byteOffset, container.byteLength)
    .setUint32(MAGIC_BYTES.length, manifest.length, false);
  container.set(manifest, FORM_CONTAINER_HEADER_BYTES);

  let cursor = FORM_CONTAINER_HEADER_BYTES + manifest.length;
  for (const bytes of valueBytes) { container.set(bytes, cursor); cursor += bytes.length; }
  for (const file of files) { container.set(file.bytes, cursor); cursor += file.bytes.length; }
  return container;
}

function readManifest(bytes, limits) {
  if (bytes.length > formContainerCeiling(limits)) refuse('container_too_large');
  if (bytes.length < FORM_CONTAINER_HEADER_BYTES) refuse('container_too_small');
  for (let index = 0; index < MAGIC_BYTES.length; index += 1) {
    if (bytes[index] !== MAGIC_BYTES[index]) refuse('bad_magic');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const manifestLength = view.getUint32(MAGIC_BYTES.length, false);
  // Against the fixed ceiling *before* the buffer, so a hostile length is refused without
  // reference to how much was actually sent.
  if (manifestLength > MAX_FORM_MANIFEST_BYTES) refuse('manifest_length_out_of_range');
  const payloadStart = FORM_CONTAINER_HEADER_BYTES + manifestLength;
  if (payloadStart > bytes.length) refuse('manifest_truncated');

  let text;
  try {
    text = strictDecoder.decode(bytes.subarray(FORM_CONTAINER_HEADER_BYTES, payloadStart));
  } catch {
    refuse('manifest_not_utf8');
  }

  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    refuse('manifest_not_json');
  }
  return { manifest, payloadStart };
}

function validateManifest(manifest, payloadLength, limits) {
  if (!hasExactKeys(manifest, ['kind', 'contract', 'values', 'files'])) refuse('manifest_shape');
  if (manifest.kind !== PAYLOAD_KIND_FORM) refuse('manifest_shape');
  if (typeof manifest.contract !== 'string' || !CONTRACT_DIGEST_PATTERN.test(manifest.contract)) {
    refuse('bad_contract_digest');
  }
  if (!Array.isArray(manifest.values) || !Array.isArray(manifest.files)) refuse('manifest_shape');
  if (manifest.values.length > MAX_FIELDS) refuse('field_count');
  if (manifest.files.length > limits.maxFiles) refuse('file_count');

  // Contiguous, ordered and non-overlapping is one check: each entry starts exactly where
  // the previous one ended, values first and then files, so no byte is unaccounted for and
  // none is claimed twice.
  let running = 0;
  for (const entry of manifest.values) {
    if (!hasExactKeys(entry, ['field', 'size', 'offset'])) refuse('manifest_shape');
    if (typeof entry.field !== 'string') refuse('manifest_shape');
    if (!isByteCount(entry.size, LARGEST_VALUE_CEILING)) refuse('value_size');
    if (!isByteCount(entry.offset, payloadLength) || entry.offset !== running) refuse('offsets');
    running += entry.size;
  }

  let fileTotal = 0;
  for (const file of manifest.files) {
    if (!hasExactKeys(file, ['field', 'name', 'size', 'offset', 'sha256', 'type'])) refuse('manifest_shape');
    if (typeof file.field !== 'string') refuse('manifest_shape');
    if (typeof file.name !== 'string' || typeof file.type !== 'string') refuse('manifest_shape');
    if (typeof file.sha256 !== 'string') refuse('manifest_shape');
    // Canonical only: accepting a name and cleaning it up here would mean the bytes that
    // were hashed and the label that gets displayed disagree.
    if (sanitizeFileName(file.name) !== file.name) refuse('file_name');
    if (sanitizeFileType(file.type) !== file.type) refuse('file_type');
    if (!SHA256_HEX.test(file.sha256)) refuse('digest_format');
    if (!isByteCount(file.size, limits.maxFileBytes)) refuse('file_size');
    if (!isByteCount(file.offset, payloadLength) || file.offset !== running) refuse('offsets');
    running += file.size;
    fileTotal += file.size;
    if (fileTotal > limits.maxTotalBytes) refuse('total_size');
  }

  if (running !== payloadLength) refuse('offsets');
}

/**
 * Decodes a container that carries **values only**, synchronously.
 *
 * This exists for one reason and it is a correctness reason, not a performance one: the
 * claim seam is synchronous from its lookup to its retirement, because that is what makes
 * "exactly one claim" true without a lock — there is no `await` between the check that the
 * drop is still claimable and the mutation that spends it. An async decode in the middle of
 * that would open precisely the window the design closes.
 *
 * It is only safe to be synchronous because a value-only container has nothing to verify
 * asynchronously: SHA-256 appears in this format solely for file entries. A container with
 * any file entry is therefore refused here rather than partially handled, and its caller is
 * expected to use the framed transfer instead.
 */
export function decodeFormValuesSync(container, { contractDigest, limits } = {}) {
  const resolved = resolveFileLimits(limits);
  if (!(container instanceof Uint8Array)) refuse('not_bytes');
  if (typeof contractDigest !== 'string' || !CONTRACT_DIGEST_PATTERN.test(contractDigest)) {
    refuse('bad_contract_digest');
  }

  const { manifest, payloadStart } = readManifest(container, resolved);
  validateManifest(manifest, container.length - payloadStart, resolved);
  if (manifest.contract !== contractDigest) refuse('contract_mismatch');
  if (manifest.files.length > 0) refuse('files_need_framed_claim');

  const values = [];
  for (const entry of manifest.values) {
    const start = payloadStart + entry.offset;
    let value;
    try {
      value = strictDecoder.decode(container.subarray(start, start + entry.size));
    } catch {
      refuse('value_not_utf8');
    }
    values.push({ field: entry.field, value });
  }
  return { kind: PAYLOAD_KIND_FORM, contract: manifest.contract, values };
}

/**
 * Parses and fully verifies one container, and checks it against the contract digest the
 * broker minted under.
 *
 * Ownership is HDROP2's exactly: `bytes` are **views into `container`**, never copies, so
 * the container stays alive as long as any view does and `container.fill(0)` empties every
 * view handed out here. Digests are verified at this moment and no later.
 *
 * Values come back as an ordered array of `{ field, value }`. Turning that into a mapping is
 * the caller's job, and the trusted seams do it against the contract's own id allowlist.
 */
export async function decodeFormContainer(container, { contractDigest, limits } = {}) {
  const resolved = resolveFileLimits(limits);
  if (!(container instanceof Uint8Array)) refuse('not_bytes');
  if (typeof contractDigest !== 'string' || !CONTRACT_DIGEST_PATTERN.test(contractDigest)) {
    refuse('bad_contract_digest');
  }

  const { manifest, payloadStart } = readManifest(container, resolved);
  validateManifest(manifest, container.length - payloadStart, resolved);
  // The AEAD has already made this near-unreachable — `info` binds the digest, so a
  // ciphertext sealed under another contract does not open at all. This is the residual
  // case: a broker whose stored contract is not the one the manifest names.
  if (manifest.contract !== contractDigest) refuse('contract_mismatch');

  const values = [];
  for (const entry of manifest.values) {
    const start = payloadStart + entry.offset;
    let value;
    try {
      value = strictDecoder.decode(container.subarray(start, start + entry.size));
    } catch {
      refuse('value_not_utf8');
    }
    values.push({ field: entry.field, value });
  }

  const files = [];
  for (const file of manifest.files) {
    const start = payloadStart + file.offset;
    const bytes = container.subarray(start, start + file.size);
    // Verified before the caller can see the bytes, for every file — a claim must not
    // succeed on a payload that was altered in transit or in memory.
    if ((await sha256Hex(bytes)) !== file.sha256) refuse('hash_mismatch');
    files.push({
      field: file.field,
      name: file.name,
      type: file.type,
      size: file.size,
      offset: file.offset,
      sha256: file.sha256,
      bytes,
    });
  }

  return {
    kind: PAYLOAD_KIND_FORM,
    contract: manifest.contract,
    values,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}
