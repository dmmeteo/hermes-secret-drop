// RFC 9180 HPKE Base mode, single-shot, DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256
// / AES-256-GCM — the suite this project standardises on (see README, How it works).
//
// Isomorphic: imported directly by the broker and bundled into the browser page,
// so both sides construct `info` from the same code. WebCrypto only.
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';

/** Envelope format version. Bound into `info`; unknown values are rejected. */
export const ENVELOPE_VERSION = 1;

/** The single allowlisted suite. No negotiation in this prototype. */
export const SUITE_ID = 'DHKEM(P-256,HKDF-SHA256)/HKDF-SHA256/AES-256-GCM';

/** RFC 9180 §7 registered code points for the suite above. */
export const SUITE_CODE_POINTS = Object.freeze({ kem: 0x0010, kdf: 0x0001, aead: 0x0002 });

/** RFC 9180: Nenc = Npk = 65 for DHKEM(P-256, HKDF-SHA256); AES-GCM tag is 16 bytes. */
export const ENC_BYTES = 65;
export const PUBLIC_KEY_BYTES = 65;
export const AEAD_TAG_BYTES = 16;

/** Fixed ASCII domain-separation label for the `info` binding. */
export const INFO_LABEL = 'hermes-handoff/v1';

/** Length of a base64url handoff id (16 CSPRNG bytes) — fixed width inside `info`. */
export const HANDOFF_ID_LENGTH = 22;

/**
 * Length of a base64url capability (16 CSPRNG bytes = 128 bits of entropy).
 *
 * 128 bits, not 256, because this is an online-only bearer token: nothing is
 * persisted, the only stored form is `SHA-256(capability)` in a process that
 * dies with the handoff, every wrong guess gets the same generic unavailable,
 * and the whole window is one 30-minute TTL. There is no offline attack to
 * resist, so the standard symmetric level is a wide margin — and a 22-character
 * fragment is a link a person can actually open on a phone.
 *
 * Note the shape collision this creates: a capability is now exactly as long as
 * a `HANDOFF_ID_LENGTH` id, so shape alone no longer tells them apart. Nothing
 * security-relevant depended on that, but redaction checks that used to lean on
 * the 43-character shape must now match the value itself.
 */
export const CAPABILITY_LENGTH = 22;

/** Bytes behind `CAPABILITY_LENGTH`; the broker's CSPRNG draw. */
export const CAPABILITY_BYTES = 16;

export function createSuite() {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export function utf8(value) {
  return new TextEncoder().encode(value);
}

/** SHA-256 of the capability. Only the hash is ever stored, logged or bound. */
export function capabilityHash(capability) {
  return sha256(utf8(capability));
}

/** SHA-256(pk_R) truncated to 16 bytes — lets the broker fail closed on a stale key. */
export async function publicKeyFingerprint(publicKeyBytes) {
  return (await sha256(publicKeyBytes)).subarray(0, 16);
}

function suiteCodePointBytes() {
  const out = new Uint8Array(6);
  new DataView(out.buffer).setUint16(0, SUITE_CODE_POINTS.kem, false);
  new DataView(out.buffer).setUint16(2, SUITE_CODE_POINTS.kdf, false);
  new DataView(out.buffer).setUint16(4, SUITE_CODE_POINTS.aead, false);
  return out;
}

/** The envelope version from which `info` also binds a form contract digest. */
export const CONTRACT_BOUND_VERSION = 3;

/** Lowercase hex, fixed width — the only digest spelling `buildInfo` accepts. */
const CONTRACT_DIGEST_HEX = /^[0-9a-f]{64}$/;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * info = "hermes-handoff/v1" || 0x00 || version || suite_id(6) || handoff_id(22)
 *        || SHA-256(capability)(32)
 *        || SHA-256(canonical form contract)(32)    — version >= 3 only
 *
 * Authenticated but never transmitted; both sides derive it independently, so a
 * ciphertext sealed for one handoff/version/suite cannot be opened as another.
 * `aad` stays empty per RFC 9180 §8.1.
 *
 * The contract digest is appended only from version 3, so v1 and v2 `info` stay
 * **byte-identical** to what they have always been — the RFC 9180 vectors and every
 * existing ciphertext keep working, and the suite pins that rather than assuming it.
 *
 * What the extra 32 bytes buy, stated narrowly: the page seals under the contract it was
 * served, and the broker opens under the contract it stored. If those differ — a relabelled
 * field, a `secret` retyped as `text`, a swapped consumer — the AEAD does not open, the drop
 * stays pending, and the attempt is charged to the existing failure budget. It does **not**
 * authenticate the JavaScript the server sent, and it does **not** identify the submitter.
 * Neither is claimed anywhere.
 */
export function buildInfo({
  handoffId,
  capabilityHash: capHash,
  version = ENVELOPE_VERSION,
  contractDigest = null,
}) {
  if (typeof handoffId !== 'string' || handoffId.length !== HANDOFF_ID_LENGTH) {
    throw new TypeError('handoffId must be a fixed-length base64url id');
  }
  if (!(capHash instanceof Uint8Array) || capHash.length !== 32) {
    throw new TypeError('capabilityHash must be 32 bytes');
  }
  // Fail closed both ways: a contract-bound version without a digest would silently seal
  // an unbound ciphertext, and a digest on an older version would change bytes that other
  // deployments already depend on.
  const bindsContract = version >= CONTRACT_BOUND_VERSION;
  if (bindsContract && (typeof contractDigest !== 'string' || !CONTRACT_DIGEST_HEX.test(contractDigest))) {
    throw new TypeError('contractDigest must be 64 lowercase hex characters');
  }
  if (!bindsContract && contractDigest !== null) {
    throw new TypeError('contractDigest is only bound from version 3');
  }
  const label = utf8(INFO_LABEL);
  const id = utf8(handoffId);
  const suite = suiteCodePointBytes();
  const digest = bindsContract ? hexToBytes(contractDigest) : new Uint8Array(0);
  const info = new Uint8Array(
    label.length + 1 + 1 + suite.length + id.length + capHash.length + digest.length,
  );
  let offset = 0;
  info.set(label, offset); offset += label.length;
  info[offset] = 0x00; offset += 1;
  info[offset] = version; offset += 1;
  info.set(suite, offset); offset += suite.length;
  info.set(id, offset); offset += id.length;
  info.set(capHash, offset); offset += capHash.length;
  info.set(digest, offset);
  return info;
}

/** Empty AAD: single-shot applications bind context through `info` (RFC 9180 §8.1). */
export const EMPTY_AAD = new Uint8Array(0);
