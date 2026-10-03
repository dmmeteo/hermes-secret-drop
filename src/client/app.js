import { DEFAULT_FILE_LIMITS, FILE_ENVELOPE_VERSION, PAYLOAD_KIND_FILES, PAYLOAD_KIND_TEXT, PAYLOAD_KIND_UNIVERSAL, encodeFileContainer } from '../file-container.js';
import { PAYLOAD_KIND_FORM } from '../form-container.js';
import { parseOutboundFragment } from '../outbound-envelope.js';
import { isSensitiveFieldType, parseOutboundPayload } from '../outbound-payload.js';
import { createDeadline, formatRemaining } from './countdown.js';
import { renderFormFields } from './form-view.js';
import { fetchMetadata, plaintextByteLength, readCapability, sealBytesEnvelope, sealEnvelope, sealFormEnvelope, submitEnvelope } from './handoff-client.js';
import { fetchOutboundMetadata, newClaimId, revealSecret } from './reveal-client.js';
import { renderRevealedFields, writeToClipboard } from './reveal-view.js';
import { checkLink } from './link-check.js';

const $ = (id) => document.getElementById(id);
// Built by filtering rather than as a literal, because one page serves both
// directions and a section is only in the document once its slice has shipped. A
// missing id is a screen this build cannot show, not a crash on load.
const screens = Object.fromEntries(
  ['form', 'success', 'unavailable', 'reveal', 'revealed', 'check-failed']
    .map((name) => [name, $(name)])
    .filter(([, element]) => element !== null),
);
const textarea = $('secret');
const sendButton = $('send');
const note = $('note');
const ttlNote = $('ttl');
const filePanel = $('file-panel');
const fileInput = $('files');
const dropZone = $('drop-zone');
const fileList = $('file-list');
const fileTotal = $('file-total');
const formTitle = $('form-title');
const requestDescription = $('request-description');
const filesLimits = $('files-limits');
const formFields = $('form-fields');
// The rendered contract's reader, or null for every drop that is not a form — which is
// what keeps a universal or typed drop exactly the page it has always been.
let formView = null;
let selectedFiles = [];
/**
 * The exact number of files this drop will accept, or null for "up to the advertised
 * maximum". Mirrored from the descriptor purely to shape the controls and the copy:
 * the broker checks the real count on the decoded container, so everything this
 * variable does is a convenience for the sender.
 */
let expectFiles = null;
/**
 * The status line under the composer. It says one thing at a time, only when there is
 * a problem the sender can act on, and is empty otherwise -- a line that always reads
 * something is a line nobody reads.
 */
function report(message = '') {
  if (!note) return;
  note.textContent = message;
  note.classList[message === '' ? 'remove' : 'add']('note-problem');
}
let metadata = null;
let deadline = null;
let ticker = null;
let pending = null; // exact sealed envelope + declaration, retained for retry
const capability = readCapability(window.location.hash);
const origin = window.location.origin;

// Which screens keep a live countdown: the two that are still waiting on a person.
// Everything else is terminal, and a terminal screen that let a ticker keep running
// could be repainted into `unavailable` after the work already succeeded.
const COUNTING_SCREENS = new Set(['form', 'reveal']);
function show(name) {
  if (!COUNTING_SCREENS.has(name)) stopCountdown();
  for (const [key, section] of Object.entries(screens)) section.hidden = key !== name;
  $('app').dataset.state = name;
}
function stopCountdown() { deadline = null; if (ticker !== null) window.clearInterval(ticker); ticker = null; }
// Which element the countdown writes into. The inbound form and the reveal gate each
// have their own, and only one of the two is ever live in a page.
let ttlTarget = ttlNote;
// The label last written to the clock. The digits repaint every second; the label is
// whole minutes and changes sixty times less often, and rewriting it on every tick
// would make a screen reader announce the time once a second on a page whose whole
// point is that someone is trying to concentrate on pasting a credential.
let ttlLabel = '';
function renderRemaining() {
  if (!deadline || !ttlTarget) return;
  const remaining = deadline.remaining();
  ttlTarget.textContent = formatRemaining(remaining);
  const minutes = Math.ceil(remaining / 60000);
  const label = remaining <= 0 ? 'expired' : `Time remaining: ${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (label !== ttlLabel) { ttlLabel = label; ttlTarget.setAttribute('aria-label', label); }
  if (remaining <= 0) show('unavailable');
}
/**
 * The built-in English chrome for each payload kind.
 *
 * Static strings chosen by the *broker-declared* kind, never composed from anything a
 * requester sent: the page's own voice stays the page's. A descriptor may add a
 * sentence and replace the heading, and that is all it may do.
 *
 * `lede` is the fallback supporting line, and only `universal` has one. On a typed
 * drop the heading already says which lane it is, so a line under it saying the same
 * thing again is the clutter this layout exists to remove. On `universal` the sender
 * genuinely has a choice to make, and nothing else on the page tells them they have
 * it -- so that one line earns its place.
 */
const MODE_COPY = {
  text: { title: 'Send text', lede: null },
  files: { title: 'Upload files', lede: null },
  universal: { title: 'Send privately', lede: 'You can send text, files, or both.' },
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function limits() {
  return { maxFiles: metadata?.max_files ?? DEFAULT_FILE_LIMITS.maxFiles, maxFileBytes: metadata?.max_file_bytes ?? DEFAULT_FILE_LIMITS.maxFileBytes, maxTotalBytes: metadata?.max_total_bytes ?? DEFAULT_FILE_LIMITS.maxTotalBytes };
}
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * What the file panel says it wants. Driven by the drop's own advertised limits
 * rather than hardcoded, which is what keeps the sentence true when an operator
 * narrows `HANDOFF_MAX_FILES` or a requester narrows `max_files`.
 *
 * The distinction the copy has to carry: an exact count is a promise the broker will
 * enforce, and an upper bound is not. Absent an expectation the page says "up to N"
 * and never invents an exactness nobody asked for.
 */
function fileWantCopy() {
  const cap = limits();
  const total = `${formatBytes(cap.maxTotalBytes)} total`;
  // The count is stated once, in the instruction on the zone itself. What is left for
  // this line is the ceilings -- disclosed here, before a sender picks a file too
  // large, rather than only inside the error they get afterwards.
  //
  // The per-file ceiling is only a SECOND rule when it is actually lower than the
  // total. On a default deployment the two are equal, and printing both would be the
  // same number twice in one line: a rule nobody can break stated as though they
  // could.
  const ceilings = cap.maxFileBytes < cap.maxTotalBytes
    ? `${total}, ${formatBytes(cap.maxFileBytes)} per file`
    : total;
  if (expectFiles !== null) return ceilings;
  return `Up to ${plural(cap.maxFiles, 'file')}, ${ceilings}`;
}

/**
 * The instruction on the drop zone, which is also the button's accessible name.
 *
 * This is where an exact count belongs: on the control the sender is about to use, in
 * the sentence telling them to use it. It used to be said three times -- a heading, a
 * limits line and a counter -- which is three chances to read a different number.
 */
function dropZoneCopy() {
  if (expectFiles !== null) return `Choose ${plural(expectFiles, 'file')} or drag them here`;
  // On a universal drop the textarea is the request and files are the option beside
  // it, so the zone reads as the secondary lane it is.
  if (metadata?.payload_kind === PAYLOAD_KIND_UNIVERSAL) return 'Or attach files';
  return 'Choose files or drag them here';
}

function renderFiles() {
  if (!fileList || !fileTotal) return;
  fileList.textContent = '';
  selectedFiles.forEach((file, index) => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'name'; name.textContent = file.name;
    const size = document.createElement('span'); size.className = 'meta'; size.textContent = formatBytes(file.size);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => { selectedFiles.splice(index, 1); renderFiles(); });
    li.append(name, size, remove); fileList.append(li);
  });
  const total = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  // Nothing selected is nothing to count: the row is hidden rather than parked at
  // "0 of 2 files · 0 B", which was a line that could only ever be read past.
  fileTotal.hidden = selectedFiles.length === 0;
  // Progress against the expectation when there is one, so a sender can see how far
  // along they are without counting rows. The size is dropped from that case on
  // purpose -- each row already carries its own, and the count is the thing the
  // broker will actually enforce.
  fileTotal.textContent = expectFiles === null
    ? `${plural(selectedFiles.length, 'file')} · ${formatBytes(total)}`
    : `${selectedFiles.length} of ${expectFiles} selected`;
}
function addFiles(files) {
  if (pending) return;
  const candidate = [...selectedFiles, ...files];
  const cap = limits();
  // An exact expectation is also a ceiling: a sixth file and a third file are refused
  // by the same line, and the message says which rule was met.
  if (expectFiles !== null && candidate.length > expectFiles) {
    report(`This request is for exactly ${plural(expectFiles, 'file')}`);
    return;
  }
  if (candidate.length > cap.maxFiles) { report(`Choose at most ${cap.maxFiles} files`); return; }
  if (candidate.some((f) => f.size > cap.maxFileBytes)) { report(`Each file must be at most ${formatBytes(cap.maxFileBytes)}`); return; }
  const total = candidate.reduce((sum, f) => sum + f.size, 0);
  if (total > cap.maxTotalBytes) { report(`Files must total at most ${formatBytes(cap.maxTotalBytes)}`); return; }
  // A successful selection is visible in the list and the tally. It does not also
  // need a sentence congratulating the sender for making it.
  selectedFiles = candidate; renderFiles(); report();
}
/**
 * Adapts the form to the drop it is serving, then renders the descriptor.
 *
 * Two sources, kept apart deliberately. The *mode* comes from `payload_kind`, which
 * the broker fixed at mint and binds into the AEAD -- so which controls appear is not
 * something a descriptor can talk the page into. The *copy* comes from the descriptor,
 * and is written with `textContent` into elements that already exist in the shipped
 * document: no node is built from it, no attribute is set from it, and no anchor is
 * ever created, so a description containing markup renders as those characters.
 *
 * That is a defence against a description becoming *code*. It is not a defence against
 * a description being *misleading* -- copy can still lie in plain words, which is what
 * the bounds and the model-facing guidance are for, and why the page's own promises
 * about expiry and secrecy live outside the rewritable span (src/public/index.html).
 */
function applyFormDescriptor() {
  const kind = metadata?.payload_kind;
  const copy = MODE_COPY[kind] ?? MODE_COPY.universal;
  if (formTitle) formTitle.textContent = copy.title;

  // A form drop is a different screen: the contract's own fields replace the generic
  // textarea and picker entirely, so neither is drawn and neither can be submitted.
  // Returning early here is what keeps every other kind byte-for-byte the page it was.
  if (kind === PAYLOAD_KIND_FORM) return applyFormContract();

  // `metadata.form` is absent entirely on a drop minted without a descriptor, which
  // is every drop that predates this. Absent and empty behave identically here.
  const descriptor = metadata?.form ?? null;
  expectFiles = Number.isInteger(descriptor?.expect_files) ? descriptor.expect_files : null;

  if (formTitle && typeof descriptor?.label === 'string' && descriptor.label.length > 0) {
    formTitle.textContent = descriptor.label;
  }
  if (requestDescription) {
    // One supporting paragraph, from one of two sources, never both. A requester's own
    // sentence is always the better answer to "why am I being asked this", so it wins;
    // the built-in line is what is left when nobody said anything. This is also the
    // one element on the page whose language is not necessarily English.
    const described = typeof descriptor?.description === 'string' && descriptor.description.length > 0;
    const text = described ? descriptor.description : (copy.lede ?? '');
    requestDescription.textContent = text;
    // Collapsed rather than left empty: an empty paragraph would leave a gap where a
    // sentence used to be.
    requestDescription.hidden = text.length === 0;
  }

  // Which controls this drop can actually accept. A `text` drop's file lane does not
  // exist -- the broker refuses a container against it before any crypto -- so showing
  // a picker would be offering something that cannot work.
  if (textarea) textarea.hidden = kind === PAYLOAD_KIND_FILES;
  if (filePanel) {
    filePanel.hidden = kind === PAYLOAD_KIND_TEXT;
    // Where both lanes are open the composer is the request and the picker is the
    // option beside it, so the picker is drawn quieter rather than given equal weight.
    filePanel.classList[kind === PAYLOAD_KIND_UNIVERSAL ? 'add' : 'remove']('file-panel--secondary');
  }
  if (dropZone) dropZone.textContent = dropZoneCopy();
  if (filesLimits) filesLimits.textContent = fileWantCopy();
  renderFiles();
}

/**
 * The declarative form: title, one supporting sentence, the fields, then Send.
 *
 * The contract was already re-validated in `fetchMetadata` — and the digest the page
 * derived from it had to equal the one the broker published, or the page would never
 * have got here — so what is rendered is what will be sealed.
 */
function applyFormContract() {
  const contract = metadata.form_contract;
  if (formTitle && typeof contract.title === 'string' && contract.title.length > 0) {
    formTitle.textContent = contract.title;
  }
  if (requestDescription) {
    const text = typeof contract.description === 'string' ? contract.description : '';
    requestDescription.textContent = text;
    requestDescription.hidden = text.length === 0;
  }
  // The generic controls are not merely hidden, they are never used: `send` reads the
  // form view when there is one and does not look at them at all.
  if (textarea) textarea.hidden = true;
  if (filePanel) filePanel.hidden = true;
  if (!formFields) return;
  formFields.hidden = false;
  formView = renderFormFields({
    document,
    list: formFields,
    contract,
    // Typing clears a stale complaint. The message is only ever regenerated by Send,
    // so nobody is told what is wrong with a field while they are still filling it in.
    onChange: () => { if (note.textContent !== '') report(); },
  });
}

/**
 * Why this submission cannot go yet, or null.
 *
 * A convenience for the sender and nothing more: every rule here is enforced again by
 * the broker on the decoded payload, and a page that skipped all of it would be safe
 * and merely unhelpful.
 */
function submissionProblem() {
  const kind = metadata?.payload_kind;
  if (kind === PAYLOAD_KIND_FILES) {
    if (expectFiles !== null && selectedFiles.length !== expectFiles) {
      return `This request is for exactly ${plural(expectFiles, 'file')}`;
    }
    if (selectedFiles.length === 0) return 'Choose the files to send';
    return null;
  }
  if (textarea.value.length === 0 && selectedFiles.length === 0) return '';
  if (expectFiles !== null && selectedFiles.length > 0 && selectedFiles.length !== expectFiles) {
    return `This request is for exactly ${plural(expectFiles, 'file')}`;
  }
  return null;
}

function wireInbound() {
  fileInput?.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  // The zone is a button, so this is the click a keyboard Enter or Space produces too.
  dropZone?.addEventListener('click', () => { if (!pending) fileInput?.click(); });
  if (dropZone) for (const type of ['dragenter', 'dragover']) dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add('drag'); });
  if (dropZone) for (const type of ['dragleave', 'drop']) dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove('drag'); if (type === 'drop') addFiles([...event.dataTransfer.files]); });
  sendButton.addEventListener('click', send);
  textarea.addEventListener('input', () => { if (!metadata) return; const size = plaintextByteLength(textarea.value); report(size > metadata.max_plaintext_bytes ? `Too large — keep it under ${metadata.max_plaintext_bytes} bytes` : ''); });
}

// One initial check and at most one explicit retry at a time. Keep Retry focusable
// while busy, so a repeated failure does not strand keyboard or screen-reader users.
async function loadLink(load, open) {
  let checking = false;
  let finished = false;
  const button = $('check-retry');
  const status = $('check-note');
  async function attempt() {
    if (checking || finished) return;
    checking = true;
    if (button) { button.setAttribute('aria-disabled', 'true'); button.textContent = 'Checking…'; }
    if (status) status.textContent = 'Checking link…';
    const outcome = await checkLink(load);
    checking = false;
    if (button) { button.setAttribute('aria-disabled', 'false'); button.textContent = 'Retry'; }
    if (outcome.status === 'unreachable') {
      if (status) status.textContent = 'Could not check the link. Try again.';
      const firstFailure = $('app').dataset.state !== 'check-failed';
      show('check-failed');
      if (firstFailure) button?.focus();
      return;
    }
    finished = true;
    if (outcome.status === 'unavailable') return show('unavailable');
    open(outcome.value, outcome.askedAt);
  }
  button?.addEventListener('click', attempt);
  await attempt();
}

function start() {
  if (!capability) return show('unavailable');
  return loadLink(
    (signal) => fetchMetadata({ capability, origin, signal }),
    openForm,
  );
}

function openForm(value, askedAt) {
  metadata = value;
  // The kinds this page can serve. `files` is new here: until a requester could ask
  // for one, no file-kind drop was ever minted with a browser in mind, so the page
  // refused it rather than render a form whose textarea could not be submitted. It can
  // now, and the lane it needs -- a v2 container behind the `files` declaration -- is
  // one this bundle already seals for universal drops. Anything OUTSIDE this set is
  // still a broker this page does not understand, and still `unavailable`.
  const servable = [PAYLOAD_KIND_TEXT, PAYLOAD_KIND_FILES, PAYLOAD_KIND_UNIVERSAL, PAYLOAD_KIND_FORM];
  if (!metadata || !servable.includes(metadata.payload_kind)) return show('unavailable');
  deadline = createDeadline({ expiresAt: metadata.expires_at, now: metadata.now, elapsedSinceAnswerMs: performance.now() - askedAt });
  renderRemaining(); if (!deadline) return;
  // Before `show`, so the form is never painted in the generic shape and then
  // rearranged in front of the person reading it.
  applyFormDescriptor();
  show('form');
  if (formView) formView.focusFirst();
  else if (metadata.payload_kind !== PAYLOAD_KIND_FILES) textarea.focus();
  ticker = window.setInterval(renderRemaining, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderRemaining(); });
}

async function send() {
  if (!metadata || sendButton.disabled) return;
  if (formView) return sendForm();
  if (!pending) {
    const problem = submissionProblem();
    // An empty form is not an error worth writing about -- the original behaviour,
    // preserved: put the cursor where the person has to type and say nothing.
    if (problem === '') { textarea.focus(); return; }
    if (problem !== null) { report(problem); return; }
  }
  if (!pending && plaintextByteLength(textarea.value) > metadata.max_plaintext_bytes) { report(`Too large — keep it under ${metadata.max_plaintext_bytes} bytes`); return; }
  sendButton.disabled = true; sendButton.textContent = 'Sending…'; textarea.readOnly = true; if (fileInput) fileInput.disabled = true; if (dropZone) dropZone.disabled = true;
  try {
    if (!pending) {
      if (selectedFiles.length === 0) pending = { declaration: 'text', envelope: await sealEnvelope({ capability, metadata, plaintext: textarea.value }) };
      else {
        const files = await Promise.all(selectedFiles.map(async (file) => ({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) })));
        const container = await encodeFileContainer(files, { limits: limits(), ...(textarea.value.length === 0 ? {} : { text: textarea.value }) });
        try { pending = { declaration: 'files', envelope: await sealBytesEnvelope({ capability, metadata, bytes: container, version: FILE_ENVELOPE_VERSION }) }; }
        finally { container.fill(0); for (const file of files) file.bytes.fill(0); }
      }
    }
    const outcome = await submitEnvelope({ capability, envelope: pending.envelope, declaration: pending.declaration, origin });
    if (outcome === 'received') { pending = null; textarea.value = ''; selectedFiles = []; renderFiles(); show('success'); return; }
    if (outcome === 'unreachable') { report('Could not reach Hermes — press Send to try again'); sendButton.disabled = false; sendButton.textContent = 'Send'; return; }
    show('unavailable');
  } catch { show('unavailable'); }
}

/**
 * The form lane: read the fields, check them for the sender's benefit, seal one HDROP3
 * container under the contract's own digest, and submit it.
 *
 * The check here is a convenience and is evidence of nothing — the broker re-runs the
 * same rules from the same module on the decoded plaintext, which is the first moment
 * the real values exist. What it buys is that an honest mistake costs a keystroke
 * instead of the drop.
 */
async function sendForm() {
  if (!pending) {
    const problem = formView.problem();
    if (problem) { report(problem); return; }
  }
  sendButton.disabled = true;
  sendButton.textContent = 'Sending…';
  try {
    if (!pending) {
      const { values, files } = formView.read();
      const withBytes = await Promise.all(files.map(async (entry) => ({
        field: entry.field,
        name: entry.file.name,
        type: entry.file.type,
        bytes: new Uint8Array(await entry.file.arrayBuffer()),
      })));
      try {
        pending = {
          declaration: PAYLOAD_KIND_FORM,
          envelope: await sealFormEnvelope({ capability, metadata, values, files: withBytes }),
        };
      } finally {
        // The plaintext copies this page made, gone as soon as they are sealed. The
        // values themselves live on in the inputs until the page closes, which is the
        // browser's own storage and not something this code can wipe.
        for (const entry of withBytes) entry.bytes.fill(0);
      }
      formView.freeze();
    }
    const outcome = await submitEnvelope({ capability, envelope: pending.envelope, declaration: pending.declaration, origin });
    if (outcome === 'received') { pending = null; show('success'); return; }
    if (outcome === 'unreachable') {
      report('Could not reach Hermes — press Send to try again');
      sendButton.disabled = false;
      sendButton.textContent = 'Send';
      return;
    }
    show('unavailable');
  } catch { show('unavailable'); }
}

// ── the outbound direction: Hermes → the user ─────────────────────────────────
//
// The gate, then one reveal. Everything the MVP calls load-bearing lives in the few
// rules below rather than in the shape of the code:
//
//   - the code is typed by a person and travels only on the claim, which is the one
//     state-changing request. Loading this page performs a POST for metadata and
//     nothing else, so a preview, a scanner or an antivirus cannot consume the drop;
//   - ONE claim id per page, drawn once here and reused for every retry. A fresh one
//     would be a second claimant and would be refused however correct its code —
//     which is exactly what makes "one browser" true;
//   - the acknowledgement that destroys the payload is sent by `revealSecret` only
//     after a successful *local* decryption. A transport failure therefore leaves the
//     drop reserved to this claim id and retryable for the ack window, so a dropped
//     response does not cost the user the secret;
//   - the decryption key never leaves this function. It came out of the fragment, it
//     is handed to `revealSecret`, and it is used by `crypto.subtle` in this process.
function startReveal({ capability, key }) {
  return loadLink(
    (signal) => fetchOutboundMetadata({ capability, origin, signal }),
    (meta, askedAt) => openGate({ capability, key, meta, askedAt }),
  );
}

function openGate({ capability, key, meta, askedAt }) {
  const codeInput = $('reveal-code');
  const openButton = $('reveal-open');
  const revealNote = $('reveal-note');
  const fieldList = $('revealed-fields');
  const revealedNote = $('revealed-note');
  const revealedTitle = $('revealed-title');
  ttlTarget = $('reveal-ttl');

  // One answer for expired, already revealed, reserved by another browser, out of
  // attempts and never existed. The page is not entitled to know which, and saying
  // so would tell a link-holder whether a secret was taken.
  if (!meta) return show('unavailable');

  deadline = createDeadline({ expiresAt: meta.expires_at, now: meta.now, elapsedSinceAnswerMs: performance.now() - askedAt });
  renderRemaining();
  if (!deadline) return;

  const tries = (remaining) => `${remaining} tr${remaining === 1 ? 'y' : 'ies'} · one reveal`;
  revealNote.textContent = tries(meta.attempts_remaining);
  show('reveal');
  codeInput.focus();
  ticker = window.setInterval(renderRemaining, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderRemaining(); });

  // Drawn once for this page, not once per request. See the header above.
  const claimId = newClaimId();

  async function open() {
    if (openButton.disabled) return;
    const code = codeInput.value.trim();
    // Checked here so a mistyped length costs a keystroke rather than one of three
    // attempts; the broker checks it again and refuses uniformly.
    if (!/^[0-9]+$/.test(code) || code.length !== meta.code_length) {
      revealNote.textContent = `Enter the ${meta.code_length}-digit code from the message`;
      codeInput.focus();
      return;
    }

    openButton.disabled = true;
    openButton.textContent = 'Revealing…';
    codeInput.readOnly = true;
    const retry = (message) => {
      revealNote.textContent = message;
      openButton.disabled = false;
      openButton.textContent = 'Reveal once';
      codeInput.readOnly = false;
      codeInput.focus();
    };

    let outcome;
    try {
      outcome = await revealSecret({ capability, key, code, claimId, origin });
    } catch {
      // Nothing definitive came back. The claim may or may not have been reserved to
      // this id, and either way the *same* id may present the *same* code again
      // inside the ack window — so this is retryable and must not spend the reveal.
      return retry('Could not reach the drop — press Reveal to try again');
    }

    if (outcome.status === 'code_incorrect') {
      const remaining = outcome.attempts_remaining;
      codeInput.value = '';
      return retry(
        remaining > 0
          ? `That code is not right — ${tries(remaining)}`
          : 'That code is not right',
      );
    }
    if (outcome.status === 'invalid_code') return retry(`Enter the ${meta.code_length}-digit code`);
    if (outcome.status === 'undecryptable') {
      // The claim is still reserved to this id and nothing was acknowledged, so a
      // retry is legal — but a wrong key or a substituted ciphertext will fail the
      // same way every time, and the honest thing is to say the link is damaged
      // rather than to blame the code.
      return retry('This link could not open the value — it may be damaged');
    }
    if (outcome.status !== 'revealed') return show('unavailable');

    renderRevealed(outcome.plaintext, outcome.acknowledged);
  }

  function renderRevealed(plaintext, acknowledged) {
    const parsed = parseOutboundPayload(plaintext);
    // An opaque payload, or one from a broker speaking a schema this bundle does not
    // know: rendered as a single masked field rather than refused. The secret is
    // already open in this page and the drop is already spent, so refusing to draw it
    // would destroy a value that was delivered correctly.
    const payload = parsed.ok
      ? parsed.payload
      : { fields: [{ label: 'Private value', type: 'secret', value: plaintext }] };
    if (payload.title) revealedTitle.textContent = payload.title;

    renderRevealedFields({
      document,
      list: fieldList,
      payload,
      isSensitive: isSensitiveFieldType,
      copy: writeToClipboard,
      report: (message) => { revealedNote.textContent = message; },
    });
    show('revealed');
    // A failed acknowledgement is worth saying and never worth calling a failure: the
    // user has the value, and the broker destroys the payload at the end of the ack
    // window regardless.
    revealedNote.textContent =
      acknowledged === 'acknowledged'
        ? 'Copy what you need — this drop is now closed.'
        : 'Copy what you need now. This drop closes on its own within the minute.';
    codeInput.value = '';
  }

  openButton.addEventListener('click', open);
  codeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
}

// Which direction this link is, decided from the fragment alone — the server is never
// sent it, so the page cannot ask. An outbound fragment is `r.<capability>.<key>`; an
// inbound one is a bare capability (src/outbound-envelope.js).
const outboundFragment = parseOutboundFragment(window.location.hash);
if (outboundFragment) {
  startReveal(outboundFragment);
} else {
  wireInbound();
  start();
}
