// Drives the DECLARATIVE FORM ENGINE in a real browser engine: every shape a contract
// can take, rendered at two widths in both themes, plus byte-exact canary round trips
// through the page's own `crypto.subtle`.
//
// Why this is separate from `scripts/form-screenshots.mjs`: that one covers the legacy
// descriptor and the universal form, which are a different screen with different rules.
// Both share `scripts/lib/cdp.mjs`, so there is one implementation of the browser
// machinery and two runs that use it.
//
// Deliberately NOT part of `npm run verify`, for the reason the sibling script gives:
// it needs a browser binary CI does not promise, and a missing browser must not be
// indistinguishable from a broken form.
//
//   node scripts/form-engine-e2e.mjs [--out DIR] [--keep-open]
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHandoffBroker } from '../src/main.js';
import { controlRequest } from '../src/control-client.js';
import { receiveFileClaim } from '../src/file-claim-client.js';
import {
  THEMES,
  VIEWPORTS,
  connectCdp,
  evaluate,
  launchChrome,
  navigate,
  openPage,
  outDirFrom,
  record,
  results,
  setTheme,
  shoot,
  summarize,
  written,
} from './lib/cdp.mjs';

const outDir = outDirFrom('/home/me/.hermes/run/coding-reports/drop-engine-preview');
const keepOpen = process.argv.includes('--keep-open');

// Every value below is synthetic and was generated for this script. Nothing here is a
// real credential, host, capability or token — CONTRIBUTING.md forbids that in fixtures
// and the point of a canary is that it is recognisable, not that it is valuable.
const CANARY_USERNAME = 'ada.lovelace';
const CANARY_PASSWORD = 'canary-pw-3f9c1e — ключ 🔑';
const CANARY_API_KEY = 'sk-canary-0000-1111-2222-3333';
const CANARY_RELEASE = 'v2026.9.13';
const CANARY_NOTE = 'line one\nline two — не секрет';

/** The shapes. Each one is a contract a model could genuinely compose. */
const SHAPES = [
  {
    name: 'credential-pair',
    consumer: 'canary',
    expect: 'Email and Password, the secret masked with a reveal beside it',
    contract: {
      version: 1,
      title: 'Staging console sign-in',
      description: 'Use the staging account, not your personal one.',
      fields: [
        { id: 'email', type: 'email', label: 'Email', required: true },
        { id: 'password', type: 'secret', label: 'Password', required: true },
      ],
    },
    fill: { email: 'ops@example.test', password: CANARY_PASSWORD },
  },
  {
    name: 'credential-pair-username',
    consumer: 'canary',
    expect: 'the other concrete label — Username, not "Username or email"',
    contract: {
      version: 1,
      title: 'Staging console sign-in',
      fields: [
        { id: 'username', type: 'text', label: 'Username', required: true },
        { id: 'password', type: 'secret', label: 'Password', required: true },
      ],
    },
    fill: { username: CANARY_USERNAME, password: CANARY_PASSWORD },
  },
  {
    name: 'named-api-key',
    consumer: 'canary',
    expect: 'one masked field named for the variable it will become',
    contract: {
      version: 1,
      title: 'OpenRouter API key',
      description: 'Paste the key from the OpenRouter dashboard. Do not include other credentials.',
      fields: [{ id: 'api_key', type: 'secret', label: 'OPENROUTER_API_KEY', required: true }],
    },
    fill: { api_key: CANARY_API_KEY },
  },
  {
    name: 'mixed-fields-files',
    expect: 'text, an optional note, and two independently grouped file pickers',
    contract: {
      version: 1,
      title: 'Deployment evidence',
      description: 'Attach the logs from the failed deploy.',
      fields: [
        { id: 'release', type: 'text', label: 'Release tag', required: true },
        { id: 'notes', type: 'textarea', label: 'Notes' },
        { id: 'app_logs', type: 'files', label: 'Log files', required: true, min_files: 1, max_files: 2 },
        { id: 'conf_logs', type: 'files', label: 'Log files', min_files: 1, max_files: 2 },
      ],
    },
    maxFiles: 4,
    fill: { release: CANARY_RELEASE, notes: CANARY_NOTE },
    files: {
      app_logs: [
        { name: 'app.log', type: 'text/plain', bytes: [1, 2, 0, 255, 65] },
        { name: 'app2.log', type: 'text/plain', bytes: [9, 9] },
      ],
      conf_logs: [{ name: 'staging.env', type: '', bytes: [65, 61, 49, 10] }],
    },
  },
  {
    name: 'all-optional',
    expect: 'every field optional — legal to build, not legal to send empty',
    contract: {
      version: 1,
      title: 'Anything you can tell us',
      fields: [
        { id: 'first', type: 'text', label: 'First thing' },
        { id: 'second', type: 'text', label: 'Second thing' },
      ],
    },
    fill: { second: 'only this one' },
  },
  {
    name: 'long-unicode',
    expect: 'both bounds at once — a 60-point title over a 300-point Ukrainian description',
    contract: {
      version: 1,
      title: 'Дані для входу в консоль staging-середовища компанії',
      description:
        'Вставте ім’я користувача та пароль від staging-консолі. Не використовуйте свій особистий обліковий запис і не додавайте інших облікових даних. Якщо ви не маєте доступу до staging-середовища, скасуйте цей запит і повідомте про це у розмові, а не тут.',
      fields: [
        { id: 'username', type: 'text', label: 'Ім’я користувача', required: true },
        { id: 'note', type: 'textarea', label: 'Примітка' },
      ],
    },
    fill: { username: 'ада', note: 'нотатка' },
  },
];

const setValuesExpression = (fill) => `
  (() => {
    const out = {};
    ${Object.entries(fill)
      .map(([id, value]) => `{
        const el = document.getElementById(${JSON.stringify(`field-${id}`)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        out[${JSON.stringify(id)}] = el.value.length;
      }`)
      .join('\n    ')}
    return out;
  })()
`;

/**
 * Puts real `File` objects into one named group's picker.
 *
 * `input.files` is not assignable from script, so this goes through `DataTransfer`,
 * which is what a drag-and-drop would have produced. The bytes are built in the page
 * rather than uploaded, so nothing depends on a path the browser can reach.
 */
const setGroupFilesExpression = (field, files) => `
  (() => {
    const input = document.getElementById(${JSON.stringify(`field-${field}`)});
    const transfer = new DataTransfer();
    ${files
      .map(
        (file) => `transfer.items.add(new File([new Uint8Array(${JSON.stringify(file.bytes)})],
          ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type ?? '')} }));`,
      )
      .join('\n    ')}
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
    return input.files.length;
  })()
`;

/** What the page is showing, read once so every assertion sees the same paint. */
const STATE_EXPRESSION = `
  (() => {
    const byId = (id) => document.getElementById(id);
    const visible = (el) => !!el && !el.hidden && el.offsetParent !== null;
    const fields = [...document.querySelectorAll('#form-fields .form-field')].map((item) => {
      const control = item.querySelector('input, textarea');
      const toggle = item.querySelector('button.ghost');
      const zone = item.querySelector('button.drop-zone');
      return {
        label: item.querySelector('label').textContent,
        optional: !!item.querySelector('.optional'),
        tag: control ? control.tagName.toLowerCase() : null,
        type: control ? control.getAttribute('type') : null,
        id: control ? control.id : null,
        labelFor: item.querySelector('label').getAttribute('for'),
        focusable: control ? control.tabIndex >= 0 : false,
        revealLabel: toggle ? toggle.getAttribute('aria-label') : null,
        zoneText: zone ? zone.textContent : null,
        zoneFocusable: zone ? zone.tagName === 'BUTTON' && zone.tabIndex >= 0 : null,
      };
    });
    return {
      screen: byId('app').dataset.state,
      title: byId('form-title').textContent,
      description: byId('request-description').textContent,
      descriptionShown: visible(byId('request-description')),
      genericTextarea: visible(byId('secret')),
      genericFilePanel: visible(byId('file-panel')),
      fieldsShown: visible(byId('form-fields')),
      fields,
      note: byId('note').textContent,
      ttlShown: visible(byId('ttl')),
      ttlLabel: byId('ttl').getAttribute('aria-label'),
      aboutOpen: byId('form').querySelector('details.about').open,
      anchors: document.querySelectorAll('#form a').length,
      images: document.querySelectorAll('#form img').length,
      scripts: document.querySelectorAll('#form script').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()
`;

async function main() {
  await mkdir(outDir, { recursive: true });
  const runDir = await mkdtemp(join(tmpdir(), 'drop-engine-e2e-'));
  const controlSocketPath = join(runDir, 'control.sock');
  const chromeDir = join(runDir, 'chrome');
  await mkdir(chromeDir, { recursive: true });

  // Every broker log line, captured so the run can assert that no value reached one.
  const logLines = [];
  const capture = (level) => (line) => logLines.push(`${level} ${line}`);
  const broker = await startHandoffBroker({
    port: 0,
    controlSocketPath,
    logger: { info: capture('info'), warn: capture('warn'), error: capture('error') },
  });
  const control = (request) => controlRequest(controlSocketPath, request);
  const capabilityOf = (url) => url.split('#')[1];

  const { child, port, binary } = await launchChrome(chromeDir);
  console.log(`browser: ${binary}`);
  console.log(`broker:  ${broker.baseUrl}`);
  console.log(`output:  ${outDir}\n`);

  const { webSocketDebuggerUrl } = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  const cdp = connectCdp(webSocketDebuggerUrl);
  await cdp.ready;

  try {
    const { sessionId } = await openPage(cdp);

    // A description that opened a dialog would mean it had become script. No page here
    // legitimately opens one, so the counter IS the assertion.
    let dialogs = 0;
    cdp.on('Page.javascriptDialogOpening', (_params, from) => {
      dialogs += 1;
      cdp.send('Page.handleJavaScriptDialog', { accept: true }, from).catch(() => {});
    });

    const mint = async (shape) => {
      const request = {
        op: 'create',
        payload_kind: 'form',
        ttl_seconds: 900,
        form_contract: shape.contract,
      };
      if (shape.consumer) request.consumer = shape.consumer;
      if (shape.maxFiles) request.max_files = shape.maxFiles;
      const created = await control(request);
      if (!created.ok) throw new Error(`create failed for ${shape.name}: ${JSON.stringify(created)}`);
      return created;
    };

    // ── every shape renders, and renders only what its contract says ────────────
    for (const shape of SHAPES) {
      const created = await mint(shape);
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${capabilityOf(created.url)}`);
      const state = await evaluate(cdp, sessionId, STATE_EXPRESSION);

      record(`${shape.name}: renders the form screen`, state.screen === 'form', state.screen);
      record(
        `${shape.name}: draws exactly the contract's fields, in order`,
        state.fields.length === shape.contract.fields.length &&
          state.fields.every((field, index) =>
            field.label.startsWith(shape.contract.fields[index].label)),
        `${state.fields.length} fields`,
      );
      // The generic composer is not merely hidden behind the fields — it is not drawn
      // at all, so there is no second lane a submission could take.
      record(
        `${shape.name}: the generic textarea and picker are gone`,
        state.genericTextarea === false && state.genericFilePanel === false,
      );
      record(
        `${shape.name}: every control is labelled and keyboard reachable`,
        state.fields.every((field) =>
          (field.id !== null && field.labelFor === field.id && field.focusable) ||
          (field.zoneFocusable === true)),
      );
      record(
        `${shape.name}: optional fields say so and required ones do not`,
        state.fields.every((field, index) =>
          field.optional === (shape.contract.fields[index].required !== true)),
      );
      record(
        `${shape.name}: nothing decorative at rest`,
        state.note === '' && state.aboutOpen === false,
        `note=${JSON.stringify(state.note)}`,
      );
      record(
        `${shape.name}: the countdown is visible and labelled`,
        state.ttlShown && /^Time remaining: /.test(state.ttlLabel ?? ''),
        state.ttlLabel,
      );
      record(
        `${shape.name}: no node was built from copy`,
        state.anchors === 0 && state.images === 0 && state.scripts === 0,
        `a=${state.anchors} img=${state.images} script=${state.scripts}`,
      );

      const secretFields = shape.contract.fields.filter((field) => field.type === 'secret');
      if (secretFields.length > 0) {
        record(
          `${shape.name}: the secret is masked and has an accessible reveal`,
          state.fields.some((field) => field.type === 'password' && /^Show /.test(field.revealLabel ?? '')),
        );
      }

      for (const [viewport, size] of Object.entries(VIEWPORTS)) {
        for (const theme of THEMES) {
          await setTheme(cdp, sessionId, theme);
          await cdp.send('Emulation.setDeviceMetricsOverride', size, sessionId);
          if (viewport === 'phone') {
            const { overflow } = await evaluate(cdp, sessionId, STATE_EXPRESSION);
            record(`${shape.name}: no horizontal overflow at 390px (${theme})`, overflow <= 0, `${overflow}px`);
          }
          await shoot(cdp, sessionId, viewport, join(outDir, `${shape.name}-${viewport}-${theme}.png`));
        }
      }
      await setTheme(cdp, sessionId, 'dark');
    }

    // ── the page refuses what the contract refuses ──────────────────────────────
    {
      const shape = SHAPES[0];
      const created = await mint(shape);
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${capabilityOf(created.url)}`);

      // Nothing filled in: Send must not seal anything.
      await evaluate(cdp, sessionId, `document.getElementById('send').click()`);
      let state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
      record('invalid: an empty form is refused on the page', state.screen === 'form' && state.note !== '', state.note);
      await shoot(cdp, sessionId, 'phone', join(outDir, 'invalid-empty-phone-dark.png'));

      // A malformed email, which is the one shape rule a person can trip by typing.
      await evaluate(cdp, sessionId, setValuesExpression({ email: 'not-an-email', password: 'x' }));
      await evaluate(cdp, sessionId, `document.getElementById('send').click()`);
      state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
      record('invalid: a malformed email is refused by name', /email/i.test(state.note), state.note);
      await shoot(cdp, sessionId, 'phone', join(outDir, 'invalid-email-phone-dark.png'));

      // A required field holding only whitespace is blank, not filled.
      await evaluate(cdp, sessionId, setValuesExpression({ email: 'ops@example.test', password: '   ' }));
      await evaluate(cdp, sessionId, `document.getElementById('send').click()`);
      state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
      record('invalid: a whitespace-only required field is blank', /required/i.test(state.note), state.note);

      // The reveal actually unmasks, and says so.
      const revealed = await evaluate(cdp, sessionId, `
        (() => {
          const item = [...document.querySelectorAll('#form-fields .form-field')]
            .find((node) => node.querySelector('input[type="password"]'));
          const before = item.querySelector('input').getAttribute('type');
          item.querySelector('button.ghost').click();
          const after = item.querySelector('input').getAttribute('type');
          const label = item.querySelector('button.ghost').getAttribute('aria-label');
          item.querySelector('button.ghost').click();
          return { before, after, label, back: item.querySelector('input').getAttribute('type') };
        })()
      `);
      record(
        'the masked field reveals and re-masks',
        revealed.before === 'password' && revealed.after === 'text' &&
          revealed.back === 'password' && /^Hide /.test(revealed.label),
        JSON.stringify(revealed),
      );
    }

    // ── the canaries: byte-exact, through the page's own crypto ─────────────────
    for (const shape of SHAPES.filter((candidate) => candidate.fill)) {
      const created = await mint(shape);
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${capabilityOf(created.url)}`);
      await evaluate(cdp, sessionId, setValuesExpression(shape.fill));
      for (const [field, files] of Object.entries(shape.files ?? {})) {
        await evaluate(cdp, sessionId, setGroupFilesExpression(field, files));
      }
      await evaluate(cdp, sessionId, `document.getElementById('send').click()`);

      // Wait for the page to leave the form screen rather than sleeping a fixed time.
      let screen = 'form';
      for (let attempt = 0; attempt < 60 && screen === 'form'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        ({ screen } = await evaluate(cdp, sessionId, `({ screen: document.getElementById('app').dataset.state })`));
      }
      record(`${shape.name}: the page reports one secure send`, screen === 'success', screen);
      if (screen === 'success') {
        await shoot(cdp, sessionId, 'phone', join(outDir, `${shape.name}-sent-phone-dark.png`));
      }

      // Only what the person actually answered: an optional field left untouched is
      // absent from the submission rather than present and empty.
      const expectedValues = shape.contract.fields
        .filter((field) => field.type !== 'files' && (shape.fill[field.id] ?? '') !== '')
        .map((field) => ({ field: field.id, value: shape.fill[field.id] }));
      if (shape.files) {
        const claimed = await receiveFileClaim(controlSocketPath, created.handoff_id, { collectBytes: true });
        record(`${shape.name}: the framed claim succeeded`, claimed.ok === true, claimed.error ?? '');
        record(
          `${shape.name}: values arrived byte-exact alongside the files`,
          JSON.stringify(claimed.form?.values) === JSON.stringify(expectedValues),
          JSON.stringify(claimed.form?.values),
        );
        const wanted = Object.entries(shape.files).flatMap(([field, files]) =>
          files.map((file) => ({ field, name: file.name, bytes: file.bytes })));
        record(
          `${shape.name}: every file is byte-exact and under its own field`,
          claimed.files?.length === wanted.length &&
            wanted.every((want, index) => {
              const got = claimed.files[index];
              return got.field === want.field && got.name === want.name &&
                Buffer.compare(Buffer.from(got.bytes), Buffer.from(want.bytes)) === 0;
            }),
          (claimed.files ?? []).map((file) => `${file.field}/${file.name}`).join(' '),
        );
        const second = await receiveFileClaim(controlSocketPath, created.handoff_id, { collectBytes: true });
        record(`${shape.name}: a second framed claim is refused`, second.ok === false, second.error ?? '');
      } else {
        const claimed = await control({ op: 'claim', handoff_id: created.handoff_id });
        record(`${shape.name}: the claim succeeded`, claimed.ok === true, claimed.error ?? '');
        record(
          `${shape.name}: every value is byte-exact and keyed by its id`,
          JSON.stringify(claimed.form?.values) === JSON.stringify(expectedValues),
          JSON.stringify(claimed.form?.values),
        );
        record(
          `${shape.name}: the claim names the contract and delivery it was minted with`,
          claimed.form?.contract_digest === created.contract_digest &&
            claimed.form?.delivery?.mode === (shape.consumer ? 'consumer' : 'model'),
          `${claimed.form?.delivery?.mode}`,
        );
        const second = await control({ op: 'claim', handoff_id: created.handoff_id });
        record(`${shape.name}: a second claim is refused`, second.ok === false, second.error ?? '');
      }
    }

    // ── an unknown capability, and the expiry screen ────────────────────────────
    await navigate(cdp, sessionId, `${broker.baseUrl}/#AAAAAAAAAAAAAAAAAAAAAA`);
    let state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
    record('an unknown capability shows the unavailable screen', state.screen === 'unavailable', state.screen);
    await shoot(cdp, sessionId, 'phone', join(outDir, 'unavailable-phone-dark.png'));

    {
      // A one-second drop, opened after it has lapsed. The page must not render a form
      // it can no longer submit into.
      const created = await control({
        op: 'create', payload_kind: 'form', ttl_seconds: 1,
        form_contract: SHAPES[2].contract, consumer: 'canary',
      });
      await new Promise((resolve) => setTimeout(resolve, 1400));
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${capabilityOf(created.url)}`);
      state = await evaluate(cdp, sessionId, STATE_EXPRESSION);
      record('an expired drop shows the unavailable screen', state.screen === 'unavailable', state.screen);
      await shoot(cdp, sessionId, 'phone', join(outDir, 'expired-phone-dark.png'));
    }

    record('no description opened a JavaScript dialog', dialogs === 0, `dialogs=${dialogs}`);

    // ── nothing a person typed reached a broker log line ────────────────────────
    const secrets = [CANARY_PASSWORD, CANARY_API_KEY, CANARY_USERNAME, CANARY_RELEASE, CANARY_NOTE];
    const leaked = secrets.filter((value) => logLines.some((line) => line.includes(value)));
    record(
      'no submitted value appears in any broker log line',
      leaked.length === 0,
      `${logLines.length} log lines checked`,
    );

    // ── the inventory, derived rather than recalled ─────────────────────────────
    const onDisk = (await readdir(outDir)).filter((name) => name.endsWith('.png'));
    console.log(`\nwrote ${written.length} screenshots:`);
    for (const file of written) console.log(`  ${file.split('/').pop()}`);
    console.log(`png files now in ${outDir}: ${onDisk.length}`);
    record('every screenshot this run wrote is on disk', written.every((file) => onDisk.includes(file.split('/').pop())));
  } finally {
    if (!keepOpen) {
      cdp.close();
      child.kill('SIGTERM');
      // Wait for the browser to actually go before removing its profile: Chrome writes
      // to the profile directory on the way out, and a `rm` that races it fails with
      // ENOTEMPTY — which would turn a clean run into a non-zero exit for a reason
      // that has nothing to do with the form.
      await new Promise((resolve) => {
        const give_up = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(give_up); resolve(); });
      });
    }
    await broker.close();
    // Best effort by design: a leftover temp directory is untidy, and losing the run's
    // own summary over one would be worse.
    if (!keepOpen) await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }

  summarize();
}

main().catch((error) => {
  console.error(`form engine e2e failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
