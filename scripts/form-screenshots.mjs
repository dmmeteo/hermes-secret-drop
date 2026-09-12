// Drives the real inbound form in a real browser engine: screenshots at two viewport
// sizes for every shape the page can take, and a byte-exact canary round trip through
// the page's own crypto.
//
// Why this exists at all. `test/client-app-wiring.test.js` runs `src/client/app.js`
// against a hand-rolled fake DOM, and says so at the top: it proves the element ids,
// the state transitions and the send path line up, and nothing about rendering. That
// is the right trade for a unit test and it leaves two things unproven — that the
// layout actually works at 390px with a 300-code-point description in it, and that
// `crypto.subtle` in a browser produces an envelope this broker opens. Both are
// checked here, in Chrome.
//
// Why no Playwright or Puppeteer. CONTRIBUTING.md asks what breaks without a
// dependency, and the answer here is nothing: Chrome speaks CDP over a WebSocket,
// Node 22 has a WebSocket client built in, and the handful of commands below is the
// whole requirement. Adding a browser-automation framework to take six screenshots
// would be a large dependency and a lockfile change for something the platform
// already does.
//
// It is deliberately NOT part of `npm run verify`: it needs a browser binary, which
// CI does not promise, and a missing browser must not be indistinguishable from a
// broken form. Run it directly.
//
//   node scripts/form-screenshots.mjs [--out DIR] [--keep-open]
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHandoffBroker } from '../src/main.js';
import { controlRequest } from '../src/control-client.js';
import { receiveFileClaim } from '../src/file-claim-client.js';

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  process.env.CHROME_PATH,
].filter(Boolean);

/** Desktop and a small phone. The phone is the one that finds layout bugs. */
const VIEWPORTS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

/**
 * Both colour schemes, explicitly.
 *
 * `src/public/app.css` has carried a `prefers-color-scheme: dark` block since long
 * before this change, and the page has no theme toggle: it follows the device. A
 * headless browser defaults to **light**, which is not what most people looking at a
 * Drop link actually see — so a preview run that emulated nothing would quietly
 * document one half of the product and call it the product.
 *
 * Emulated rather than inferred, and named in the filename, so an image can never be
 * mistaken for the other scheme's.
 */
const THEMES = ['dark', 'light'];

const args = process.argv.slice(2);
const outDir = args.includes('--out')
  ? args[args.indexOf('--out') + 1]
  : '/home/me/.hermes/run/coding-reports/drop-form-preview';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── a minimal CDP client ──────────────────────────────────────────────────────
//
// One WebSocket to the browser, `flatten: true` so page sessions multiplex over it,
// and a monotonic id per command. Everything below is request/response except the
// handful of events `waitFor` parks on.
function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    for (const listener of [...listeners]) listener(message);
  });

  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      socket.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    /** Resolves on the next matching event, or rejects after `timeoutMs`. */
    waitFor(method, sessionId, timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`timed out waiting for ${method}`));
        }, timeoutMs);
        const listener = (message) => {
          if (message.method !== method) return;
          if (sessionId && message.sessionId !== sessionId) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(message.params);
        };
        listeners.add(listener);
      });
    },
    /** Subscribe to every matching event for the life of the run. */
    on(method, handler) {
      listeners.add((message) => {
        if (message.method === method) handler(message.params, message.sessionId);
      });
    },
    close() {
      socket.close();
    },
  };
}

async function launchChrome(userDataDir) {
  const binary = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!binary) throw new Error(`no chrome binary found; tried ${CHROME_CANDIDATES.join(', ')}`);

  const child = spawn(binary, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    // Port 0 means "pick one", and Chrome writes the choice into DevToolsActivePort.
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    // Nothing here talks to the network except loopback.
    '--disable-background-networking',
    '--disable-component-update',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const [port] = (await readFile(portFile, 'utf8')).split('\n');
      if (port) return { child, port: Number(port), binary };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error('chrome did not publish a devtools port');
}

/** One page, attached and with Page events on. */
async function openPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

async function setTheme(cdp, sessionId, theme) {
  await cdp.send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: theme }] },
    sessionId,
  );
}

async function navigate(cdp, sessionId, url) {
  // Via about:blank, and that is load-bearing rather than tidy. Every URL here differs
  // from the last only in its FRAGMENT, which is a same-document navigation: the
  // browser fires no load event, so a wait would hang -- and more to the point the
  // page would never re-run, because `src/client/app.js` reads the capability out of
  // the fragment once, at module load. Without a real document change the second drop
  // would be rendered by the first drop's script.
  for (const target of ['about:blank', url]) {
    const loaded = cdp.waitFor('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url: target }, sessionId);
    await loaded;
  }
  // The page fetches its metadata after load; give that round trip room to land.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate threw');
  return result.value;
}

/** Every PNG this run wrote, so the count in a report is derived and not recalled. */
const written = [];

async function shoot(cdp, sessionId, viewport, file) {
  await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORTS[viewport], sessionId);
  // Past the fold as well: a description can push the Send button down, and a
  // screenshot cropped at the viewport would hide exactly that.
  const { data } = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: true },
    sessionId,
  );
  await writeFile(file, Buffer.from(data, 'base64'));
  written.push(file);
  return file;
}

/**
 * Puts real `File` objects into the page's picker.
 *
 * `input.files` is not assignable from script, so this goes through `DataTransfer`,
 * which is what a drag-and-drop would have produced. The bytes are built in the page
 * rather than uploaded, so nothing here depends on a path the browser can reach.
 */
const setFilesExpression = (files) => `
  (() => {
    const input = document.getElementById('files');
    const transfer = new DataTransfer();
    ${files
      .map(
        (file) => `transfer.items.add(new File([new Uint8Array(${JSON.stringify([...file.bytes])})],
          ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type ?? '')} }));`,
      )
      .join('\n    ')}
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
    return document.getElementById('file-total').textContent;
  })()
`;

// ── the run ───────────────────────────────────────────────────────────────────

async function main() {
  await mkdir(outDir, { recursive: true });
  const runDir = await mkdtemp(join(tmpdir(), 'drop-form-shots-'));
  const controlSocketPath = join(runDir, 'control.sock');
  const chromeDir = join(runDir, 'chrome');
  await mkdir(chromeDir, { recursive: true });

  const broker = await startHandoffBroker({
    port: 0,
    controlSocketPath,
    logger: { info() {}, warn() {}, error() {} },
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
    // ── the shapes the form can take ─────────────────────────────────────────
    //
    // LANGUAGE. Every string the page draws for itself is English, and so is a
    // requester's `label`, because it becomes the main heading and sits directly
    // against that English chrome. `description` is the single element whose language
    // is the requester's choice. The primary pair below is therefore an ENGLISH form
    // carrying a UKRAINIAN description -- the mixed case, which is the one that can
    // actually look wrong -- and the `-en` pair is the same request in English as the
    // control. Nothing in the product detects or enforces this; it is guidance on the
    // model-facing surfaces and evidence here.
    const UK_TOKEN_DESCRIPTION = 'Вставте API-токен для staging-розгортання. Не додавайте інших облікових даних.';
    const UK_FILES_DESCRIPTION = 'Завантажте два файли конфігурації для staging-розгортання.';
    const EN_TOKEN_DESCRIPTION = 'Paste the API token for the staging deployment. Do not include other credentials.';
    const EN_FILES_DESCRIPTION = 'Upload the two configuration files for the staging deployment.';
    const shapes = [
      {
        name: 'universal-legacy',
        request: { op: 'create', payload_kind: 'universal', ttl_seconds: 900 },
        expect: 'both lanes, no descriptor — the form exactly as it shipped',
      },
      {
        name: 'text-described',
        request: {
          op: 'create',
          payload_kind: 'text',
          ttl_seconds: 900,
          form: {
            // English heading, Ukrainian description: the delivered shape.
            label: 'Staging deploy token',
            // Neutral input instruction on purpose. A requester describes WHAT TO
            // SUPPLY; it must not promise what happens to the value afterwards. A
            // generic drop has no idea what the eventual consumer does with a secret,
            // so copy like "used once and not stored" would be a retention guarantee
            // nothing in this system can keep. What the page can honestly say about
            // its own lifecycle it already says, in its own built-in words.
            description: UK_TOKEN_DESCRIPTION,
          },
        },
        expect: 'textarea only, English chrome, Ukrainian description',
      },
      {
        name: 'files-exactly-two',
        request: {
          op: 'create',
          payload_kind: 'files',
          ttl_seconds: 900,
          max_files: 5,
          form: {
            label: 'Staging deployment config',
            description: UK_FILES_DESCRIPTION,
            expect_files: 2,
          },
        },
        expect: 'picker only, exactly 2 expected, Ukrainian description',
      },
      {
        name: 'text-described-en',
        request: {
          op: 'create',
          payload_kind: 'text',
          ttl_seconds: 900,
          form: { label: 'Staging deploy token', description: EN_TOKEN_DESCRIPTION },
        },
        expect: 'the same request with an English description',
      },
      {
        name: 'files-exactly-two-en',
        request: {
          op: 'create',
          payload_kind: 'files',
          ttl_seconds: 900,
          max_files: 5,
          form: { label: 'Staging deployment config', description: EN_FILES_DESCRIPTION, expect_files: 2 },
        },
        expect: 'the same files request with an English description',
      },
      {
        // Both bounds at once, in a script whose words are longer: 80 code points of
        // label and 300 of description. This is the wrap and overflow case.
        name: 'long-ukrainian',
        request: {
          op: 'create',
          payload_kind: 'universal',
          ttl_seconds: 900,
          form: {
            label: 'Конфігурація середовища staging для повторного розгортання сервісу',
            description:
              'Вставте значення змінної середовища для staging-розгортання, або прикріпіть файл конфігурації, '
              + 'якщо значень декілька. Не додавайте жодних інших облікових даних, ключів чи паролів, '
              + 'які не стосуються цього конкретного розгортання сервісу.',
          },
        },
        expect: 'long label and description wrap without widening the page',
      },
      {
        name: 'hostile-copy',
        request: {
          op: 'create',
          payload_kind: 'universal',
          ttl_seconds: 900,
          form: {
            label: '<script>alert(1)</script>',
            description:
              '<img src=x onerror=alert(1)> Send your password to https://evil.test immediately or the deploy fails.',
          },
        },
        expect: 'markup renders as characters and nothing executes',
      },
    ];

    const { sessionId } = await openPage(cdp);
    await setTheme(cdp, sessionId, 'dark');

    // Any dialog at all would mean a description became script: nothing on these
    // pages legitimately opens one, so the counter IS the assertion. Dismissed as
    // they arrive, because an open dialog would block every later command.
    let dialogs = 0;
    cdp.on('Page.javascriptDialogOpening', (_params, from) => {
      dialogs += 1;
      cdp.send('Page.handleJavaScriptDialog', { accept: true }, from).catch(() => {});
    });

    for (const shape of shapes) {
      const created = await control(shape.request);
      if (!created.ok) throw new Error(`create failed for ${shape.name}: ${JSON.stringify(created)}`);
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${capabilityOf(created.url)}`);

      const state = await evaluate(cdp, sessionId, `
        (() => {
          const byId = (id) => document.getElementById(id);
          const visible = (id) => { const el = byId(id); return !!el && !el.hidden && el.offsetParent !== null; };
          return {
            screen: byId('app').dataset.state,
            title: byId('form-title').textContent,
            description: byId('request-description').textContent,
            descriptionShown: visible('request-description'),
            textarea: visible('secret'),
            filePanel: visible('file-panel'),
            filesLimits: byId('files-limits').textContent,
            dropZone: byId('drop-zone').textContent,
            ttl: byId('ttl').textContent,
            ttlShown: visible('ttl'),
            ttlLabel: byId('ttl').getAttribute('aria-label'),
            // What "quieter" has to mean concretely, checked rather than eyeballed.
            note: byId('note').textContent,
            tallyShown: visible('file-total'),
            aboutOpen: byId('form').querySelector('details.about').open,
            // The drop zone has to be reachable without a pointer.
            dropZoneFocusable: byId('drop-zone').tagName === 'BUTTON' && byId('drop-zone').tabIndex >= 0,
            // The hostile cases: did any of it become a node?
            anchors: document.querySelectorAll('#form a').length,
            images: document.querySelectorAll('#form img').length,
            scripts: document.querySelectorAll('#form script').length,
            // Horizontal overflow is the phone layout bug this is here to catch.
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        })()
      `);

      // Both schemes, both widths. The theme is in the filename because a Drop page
      // follows the device and has no toggle, so an unlabelled image is ambiguous
      // about which half of the product it shows.
      for (const theme of THEMES) {
        await setTheme(cdp, sessionId, theme);
        for (const viewport of Object.keys(VIEWPORTS)) {
          await shoot(cdp, sessionId, viewport, join(outDir, `${shape.name}-${viewport}-${theme}.png`));
        }
      }
      await setTheme(cdp, sessionId, 'dark');
      // Re-read overflow at phone width, which is where it actually matters.
      const phoneOverflow = await evaluate(
        cdp,
        sessionId,
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      );
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

      record(
        `render ${shape.name}`,
        state.screen === 'form',
        `${shape.expect}; textarea=${state.textarea} picker=${state.filePanel} ttl=${state.ttl}`,
      );
      record(
        `no node built from copy: ${shape.name}`,
        state.anchors === 0 && state.images === 0 && state.scripts === 0,
        `a=${state.anchors} img=${state.images} script=${state.scripts}`,
      );
      record(
        `no horizontal overflow at 390px: ${shape.name}`,
        phoneOverflow <= 0,
        `overflow=${phoneOverflow}px`,
      );
      // The three things the old page put in front of a sender that said nothing.
      record(
        `nothing decorative at rest: ${shape.name}`,
        state.note === '' && state.tallyShown === false && state.aboutOpen === false,
        `note=${JSON.stringify(state.note)} tally=${state.tallyShown} about-open=${state.aboutOpen}`,
      );
      record(
        `the countdown is visible and labelled: ${shape.name}`,
        state.ttlShown && /^\d+:\d{2}$/.test(state.ttl) && /^Time remaining: /.test(state.ttlLabel ?? ''),
        `ttl=${state.ttl} label=${JSON.stringify(state.ttlLabel)}`,
      );
      record(
        `the file chooser is keyboard reachable: ${shape.name}`,
        state.filePanel === false || state.dropZoneFocusable,
        `panel=${state.filePanel} focusable=${state.dropZoneFocusable} zone=${JSON.stringify(state.dropZone)}`,
      );
    }

    record('no javascript dialog was opened by any description', dialogs === 0, `dialogs=${dialogs}`);

    // ── canary 1: text, through the page's own crypto ────────────────────────
    const CANARY_TEXT = `canary-text-${'x'.repeat(24)}-${Date.now()}`;
    {
      const created = await control({
        op: 'create',
        payload_kind: 'text',
        ttl_seconds: 900,
        form: { description: 'Paste the staging deploy token.' },
      });
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${capabilityOf(created.url)}`);
      const outcome = await evaluate(cdp, sessionId, `
        (async () => {
          document.getElementById('secret').value = ${JSON.stringify(CANARY_TEXT)};
          document.getElementById('send').click();
          for (let i = 0; i < 100; i += 1) {
            if (document.getElementById('app').dataset.state !== 'form') break;
            await new Promise((r) => setTimeout(r, 100));
          }
          return document.getElementById('app').dataset.state;
        })()
      `);
      record('browser text submission reaches the receipt', outcome === 'success', `state=${outcome}`);

      const claimed = await control({ op: 'claim', handoff_id: created.handoff_id });
      const recovered = claimed.ok ? Buffer.from(claimed.plaintext_b64, 'base64').toString('utf8') : '';
      record('text canary recovered byte-exactly', recovered === CANARY_TEXT);

      const second = await control({ op: 'claim', handoff_id: created.handoff_id });
      record('second text claim is refused', second.ok !== true, `error=${second.error}`);
    }

    // ── canary 2: exactly two files, through the page's own crypto ───────────
    {
      const files = [
        { name: 'staging.env', type: 'text/plain', bytes: [...Buffer.from('CANARY_ONE=alpha\n')] },
        { name: 'staging.json', type: 'application/json', bytes: [0, 255, 1, 254, 2, 253] },
      ];
      const created = await control({
        op: 'create',
        payload_kind: 'files',
        ttl_seconds: 900,
        max_files: 5,
        form: { description: 'Upload the two staging config files.', expect_files: 2 },
      });
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${capabilityOf(created.url)}`);

      // One file first: the count gate must hold in the real page, not just the test.
      await evaluate(cdp, sessionId, setFilesExpression([files[0]]));
      const blocked = await evaluate(cdp, sessionId, `
        (async () => {
          document.getElementById('send').click();
          await new Promise((r) => setTimeout(r, 400));
          return { state: document.getElementById('app').dataset.state,
                   note: document.getElementById('note').textContent };
        })()
      `);
      record(
        'the page refuses a short file count',
        blocked.state === 'form',
        `note=${JSON.stringify(blocked.note)}`,
      );
      await shoot(cdp, sessionId, 'phone', join(outDir, 'files-count-short-phone-dark.png'));
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

      // Add the SECOND file to the one already chosen, which is what a person does
      // after being told the count is short. Re-adding both would be 1 + 2 = 3 and
      // would be refused -- correctly -- by the same gate.
      const tally = await evaluate(cdp, sessionId, setFilesExpression([files[1]]));
      record('the selection accumulates to the expected count', /^2 of 2 selected$/.test(tally), tally);
      const outcome = await evaluate(cdp, sessionId, `
        (async () => {
          document.getElementById('send').click();
          for (let i = 0; i < 150; i += 1) {
            if (document.getElementById('app').dataset.state !== 'form') break;
            await new Promise((r) => setTimeout(r, 100));
          }
          return document.getElementById('app').dataset.state;
        })()
      `);
      record('browser file submission reaches the receipt', outcome === 'success', `state=${outcome}`);

      const claimed = await receiveFileClaim(controlSocketPath, created.handoff_id);
      const exact =
        claimed.files?.length === 2 &&
        claimed.files.every((file, index) => {
          const want = files[index];
          return (
            file.name === want.name &&
            file.bytes.length === want.bytes.length &&
            [...file.bytes].every((byte, i) => byte === want.bytes[i])
          );
        });
      record('file canary recovered byte-exactly', Boolean(exact),
        `files=${claimed.files?.map((f) => `${f.name}:${f.bytes.length}`).join(',')}`);

      // A refused claim RESOLVES with `{ ok: false, error }` rather than throwing --
      // the client reports the broker's verdict, it does not raise on it.
      const second = await receiveFileClaim(controlSocketPath, created.handoff_id);
      record(
        'second file claim is refused',
        second.ok !== true && second.error === 'unavailable',
        `error=${second.error} phase=${second.phase}`,
      );
    }

    // ── the terminal states, for the record ──────────────────────────────────
    {
      // The receipt, captured from the page that just reached it.
      await shoot(cdp, sessionId, 'phone', join(outDir, 'received-phone-dark.png'));
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    }

    // ── outbound: shared stylesheet, deliberately NOT redesigned ─────────────
    //
    // The inbound rules above are scoped to #form and to classes only the composer
    // uses, but they live in the stylesheet this screen also loads. That intent is
    // worth a picture rather than an assertion that it was intended.
    {
      const payload = JSON.stringify({
        v: 1,
        title: 'Staging credentials',
        fields: [{ label: 'API token', type: 'secret', value: 'not-a-real-token' }],
      });
      const created = await control({
        op: 'create_outbound_drop',
        ttl_seconds: 900,
        payload_format: 'structured',
        plaintext_b64: Buffer.from(payload, 'utf8').toString('base64'),
      }).catch(() => null);
      if (created?.ok) {
        await navigate(cdp, sessionId, `${broker.baseUrl}/#${created.url.split('#')[1]}`);
        const state = await evaluate(cdp, sessionId, "document.getElementById('app').dataset.state");
        record('the outbound reveal gate still renders', state === 'reveal', `state=${state}`);
        for (const theme of THEMES) {
          await setTheme(cdp, sessionId, theme);
          await shoot(cdp, sessionId, 'phone', join(outDir, `outbound-reveal-phone-${theme}.png`));
        }
        await setTheme(cdp, sessionId, 'dark');
        await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
      } else {
        record('the outbound reveal gate still renders', false, `could not mint an outbound drop: ${JSON.stringify(created)}`);
      }
    }

    {
      const created = await control({ op: 'create', payload_kind: 'universal', ttl_seconds: 900 });
      await control({ op: 'claim', handoff_id: created.handoff_id }).catch(() => {});
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${'z'.repeat(22)}`);
      const state = await evaluate(cdp, sessionId, "document.getElementById('app').dataset.state");
      record('an unknown capability shows the unavailable screen', state === 'unavailable', `state=${state}`);
      await shoot(cdp, sessionId, 'phone', join(outDir, 'unavailable-phone-dark.png'));
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    }
  } finally {
    // Order matters, and so does not throwing: a cleanup failure here would replace
    // whatever real error sent us into this block. Chrome has to be gone before its
    // profile directory can be removed, or the rmdir races its last writes.
    cdp.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await broker.close();
    await rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch((error) => console.warn(`could not remove ${runDir}: ${error.code ?? error.message}`));
  }

  // Enumerated from what was actually written, and cross-checked against what is on
  // disk: a screenshot count quoted from memory is exactly the kind of detail that
  // drifts out of a report, and the directory is the only thing that settles it.
  const onDisk = (await readdir(outDir)).filter((name) => name.endsWith('.png')).sort();
  console.log(`\nscreenshots written this run: ${written.length}`);
  for (const file of written.map((file) => file.split('/').pop()).sort()) {
    console.log(`  ${file}`);
  }
  console.log(`png files now in ${outDir}: ${onDisk.length}`);
  if (onDisk.length !== written.length) {
    console.log(`  note: ${onDisk.length - written.length} png(s) predate this run`);
    for (const name of onDisk.filter((name) => !written.some((file) => file.endsWith(`/${name}`)))) {
      console.log(`    stale: ${name}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`browser smoke failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
