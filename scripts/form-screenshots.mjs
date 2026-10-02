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

// The browser machinery lives in scripts/lib/cdp.mjs, shared with the form-engine run.
import {
  THEMES,
  outDirFrom,
  record,
  results,
  VIEWPORTS,
  connectCdp,
  evaluate,
  launchChrome,
  navigate,
  openPage,
  setTheme,
  shoot,
  written,
} from './lib/cdp.mjs';

const outDir = outDirFrom('/home/me/.hermes/run/coding-reports/drop-form-preview');

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

/**
 * The page's layout as a person on a 390px screen meets it: does anything push the
 * page sideways, and is `selector` -- the one action -- inside the first screenful
 * without scrolling. Measured under the phone metrics, which `shoot` leaves applied.
 */
async function phoneLayout(cdp, sessionId, selector) {
  await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORTS.phone, sessionId);
  const layout = await evaluate(cdp, sessionId, `
    (() => {
      const action = document.querySelector(${JSON.stringify(selector)});
      const box = action ? action.getBoundingClientRect() : null;
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        actionBottom: box ? Math.round(box.bottom + window.scrollY) : null,
      };
    })()
  `);
  layout.clipped = await evaluate(cdp, sessionId, CLIPPED_EXPRESSION);
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  return layout;
}

/**
 * Which of the three self-hosted faces actually loaded. A declared face that never
 * loads leaves the page on its fallback silently, and a CSP that blocks fonts fails
 * exactly that way -- so the answer is read from the browser rather than assumed.
 */
const FONT_FAMILIES = ['Fixel Display', 'Fixel Text', 'Geist Mono'];
async function loadedFonts(cdp, sessionId) {
  return evaluate(cdp, sessionId, `
    (async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replace(/"/g, ''));
    })()
  `);
}

/**
 * 200% browser zoom on the 390px screen. Page zoom halves the CSS viewport, so this
 * is the same layout a person gets by zooming in: 195 CSS px wide at four device
 * pixels per CSS pixel. Kept out of the shared VIEWPORTS so the form-engine run's
 * counts do not move.
 */
/**
 * Elements of the visible screen whose box crosses its column or the window's edge. The shell clips
 * horizontal overflow, so `scrollWidth` alone would report 0 for a control that is
 * being cut off -- this measures the boxes themselves. The art is excluded: it is
 * meant to bleed and be clipped.
 */
const CLIPPED_EXPRESSION = `
  (() => {
    const screen = document.querySelector('#app > section:not([hidden])');
    if (!screen) return [];
    // The screen's own column, not the window: a control wider than its column is a
    // layout fault even while the window still has room for it.
    const column = screen.getBoundingClientRect();
    const right = Math.min(column.right, document.documentElement.clientWidth);
    return [...screen.querySelectorAll('*')]
      // .sr-only is a deliberate 1px box at -1px margin, never painted.
      .filter((node) => node.offsetParent !== null && !node.classList.contains('sr-only'))
      .map((node) => ({ node, box: node.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && (box.right > right + 0.5 || box.left < column.left - 0.5))
      .map(({ node, box }) => (node.id || node.className || node.tagName) + '@' + Math.round(box.right));
  })()
`;

const ZOOMED_PHONE = { width: 195, height: 422, deviceScaleFactor: 4, mobile: true };
async function zoomed(cdp, sessionId, file) {
  await cdp.send('Emulation.setDeviceMetricsOverride', ZOOMED_PHONE, sessionId);
  const overflow = await evaluate(cdp, sessionId,
    'document.documentElement.scrollWidth - document.documentElement.clientWidth');
  const clipped = await evaluate(cdp, sessionId, CLIPPED_EXPRESSION);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
  await writeFile(file, Buffer.from(data, 'base64'));
  written.push(file);
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  return { overflow, clipped };
}

/**
 * The wide layout's art is sticky: on a screen taller than the window it must stay in
 * view, centred in the window, while the column beside it scrolls. A full-page capture
 * cannot show that -- it lays the page out at its whole height -- so this scrolls a
 * real 1280x800 window and measures the art's box, then captures exactly what is on
 * screen at that scroll position.
 */
async function stickyArt(cdp, sessionId, file) {
  await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORTS.desktop, sessionId);
  const measure = () => evaluate(cdp, sessionId, `
    (async () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const art = document.querySelector('.aperture').getBoundingClientRect();
      return {
        scrollY: Math.round(window.scrollY),
        scrollable: document.documentElement.scrollHeight - window.innerHeight,
        artTop: Math.round(art.top),
        artBottom: Math.round(art.bottom),
        expectedTop: Math.round(Math.max(24, window.innerHeight / 2 - 240)),
        windowHeight: window.innerHeight,
      };
    })()
  `);
  const scrolled = await measure();
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await writeFile(file, Buffer.from(data, 'base64'));
  written.push(file);
  await evaluate(cdp, sessionId, 'window.scrollTo(0, 0)');
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  return scrolled;
}

/** Presses Tab `count` times through the real input pipeline, so `:focus-visible` is what a keyboard user sees. */
async function pressTab(cdp, sessionId, count) {
  for (let i = 0; i < count; i += 1) {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId);
    }
  }
  return evaluate(cdp, sessionId, "document.activeElement && (document.activeElement.id || document.activeElement.tagName)");
}

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

    // The shapes whose one action must be reachable without scrolling on a 390x844
    // screen. The long-copy and hostile shapes are excluded on purpose: they exist to
    // push the layout, and a long request is allowed to need a scroll.
    const FIRST_SCREEN = new Set(['universal-legacy', 'text-described', 'files-exactly-two', 'text-described-en', 'files-exactly-two-en']);
    let fontsChecked = false;

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
      if (FIRST_SCREEN.has(shape.name)) {
        const layout = await phoneLayout(cdp, sessionId, '#send');
        record(
          `Send is inside the first 390x844 screen: ${shape.name}`,
          layout.width === 390 && layout.actionBottom !== null && layout.actionBottom <= layout.height,
          `innerWidth=${layout.width} send-bottom=${layout.actionBottom}px of ${layout.height}px`,
        );
        record(`nothing is clipped at 390px: ${shape.name}`, layout.clipped.length === 0, JSON.stringify(layout.clipped));
      }
      if (shape.name === 'universal-legacy' || shape.name === 'long-ukrainian') {
        const zoom = await zoomed(cdp, sessionId, join(outDir, `${shape.name}-zoom200-dark.png`));
        record(`nothing overflows or is clipped at 200% zoom: ${shape.name}`, zoom.overflow <= 0 && zoom.clipped.length === 0,
          `overflow=${zoom.overflow}px clipped=${JSON.stringify(zoom.clipped)}`);
      }
      if (!fontsChecked) {
        fontsChecked = true;
        const loaded = await loadedFonts(cdp, sessionId);
        record(
          'the three self-hosted faces load under the shipped CSP',
          FONT_FAMILIES.every((family) => loaded.includes(family)),
          `loaded=${JSON.stringify(loaded)}`,
        );
      }
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

    // ── the loading state, held open ─────────────────────────────────────────
    //
    // The page shows the shell and one line while its metadata request is in flight.
    // Too brief to photograph on loopback, so the request is paused in the browser
    // until the screenshot is taken, then released.
    {
      const created = await control({ op: 'create', payload_kind: 'universal', ttl_seconds: 900 });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/metadata', requestStage: 'Request' }] }, sessionId);
      const paused = cdp.waitFor('Fetch.requestPaused', sessionId);
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${capabilityOf(created.url)}`);
      const { requestId } = await paused;
      const loading = await evaluate(cdp, sessionId, `({
        state: document.getElementById('app').dataset.state,
        note: getComputedStyle(document.querySelector('.loading-note')).display,
      })`);
      record('the loading state paints the shell and a line', loading.state === 'loading' && loading.note === 'block',
        `state=${loading.state} note-display=${loading.note}`);
      for (const theme of THEMES) {
        await setTheme(cdp, sessionId, theme);
        await shoot(cdp, sessionId, 'phone', join(outDir, `loading-phone-${theme}.png`));
      }
      await setTheme(cdp, sessionId, 'dark');
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
      await cdp.send('Fetch.continueRequest', { requestId }, sessionId);
      await cdp.send('Fetch.disable', {}, sessionId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = await evaluate(cdp, sessionId, `({
        state: document.getElementById('app').dataset.state,
        note: getComputedStyle(document.querySelector('.loading-note')).display,
      })`);
      record('the loading line is gone once a screen is chosen', after.state === 'form' && after.note === 'none',
        `state=${after.state} note-display=${after.note}`);

      // Keyboard focus, through real Tab presses: textarea (focused on load) ->
      // file chooser -> Send. Each must show the palette's ring, not nothing.
      await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORTS.phone, sessionId);
      const onSend = await pressTab(cdp, sessionId, 2);
      const ring = await evaluate(cdp, sessionId, `(() => {
        const style = getComputedStyle(document.activeElement);
        return { outline: style.outlineStyle, width: style.outlineWidth };
      })()`);
      record('Tab reaches Send and it shows a visible focus ring', onSend === 'send' && ring.outline !== 'none',
        `focused=${onSend} outline=${ring.outline} ${ring.width}`);
      for (const theme of THEMES) {
        await setTheme(cdp, sessionId, theme);
        await shoot(cdp, sessionId, 'phone', join(outDir, `focus-send-phone-${theme}.png`));
      }
      await setTheme(cdp, sessionId, 'dark');
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

      // Reduced motion: the only motion is a short colour transition, and it must go.
      await cdp.send('Emulation.setEmulatedMedia', { features: [
        { name: 'prefers-color-scheme', value: 'dark' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ] }, sessionId);
      const durations = await evaluate(cdp, sessionId, `
        ['#send', '#secret', '#drop-zone'].map((selector) => getComputedStyle(document.querySelector(selector)).transitionDuration)
      `);
      record('reduced motion removes every transition', durations.every((value) => /^0s(, 0s)*$/.test(value)),
        `durations=${JSON.stringify(durations)}`);
      await setTheme(cdp, sessionId, 'dark');

      // The arrow is drawn, never named: the button's accessible name stays its label.
      const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sessionId);
      const sendNode = nodes.find((node) => node.role?.value === 'button' && /^Send/.test(node.name?.value ?? ''));
      record('the arrow is not part of the Send button\'s accessible name', sendNode?.name?.value === 'Send',
        `name=${JSON.stringify(sendNode?.name?.value)}`);
      const centre = await evaluate(cdp, sessionId, `(() => {
        const button = document.getElementById('send');
        const range = document.createRange();
        range.selectNodeContents(button);
        const text = range.getBoundingClientRect();
        const box = button.getBoundingClientRect();
        return Math.round(Math.abs((text.left + text.width / 2) - (box.left + box.width / 2)));
      })()`);
      record('the Send label is centred on the whole button', centre <= 1, `offset=${centre}px`);
    }

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
      for (const theme of THEMES) {
        await setTheme(cdp, sessionId, theme);
        for (const viewport of Object.keys(VIEWPORTS)) {
          await shoot(cdp, sessionId, viewport, join(outDir, `received-${viewport}-${theme}.png`));
        }
      }
      await setTheme(cdp, sessionId, 'dark');
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    }

    // ── outbound: the gate, a wrong code, and the revealed values ────────────
    //
    // The revealed screen is reachable only by spending a drop, so it is driven the
    // way a person reaches it: one wrong code, then the right one. Sample values are
    // obviously fake; nothing here resembles a working credential.
    {
      const LONG_NOTE = 'Rotate after the staging smoke test passes.\nThe old value stays valid for one hour after rotation.\n'
        + 'reference: example-rotation-ticket-0000-not-real-'.repeat(2);
      const payload = JSON.stringify({
        v: 1,
        title: 'Staging credentials',
        fields: [
          { label: 'Username', type: 'text', value: 'staging-deployer' },
          { label: 'API token', type: 'secret', value: 'not-a-real-token-0123456789abcdefghijklmnopqrstuvwxyz' },
          { label: 'Console', type: 'url', value: 'https://staging.example.test/console' },
          { label: 'Notes', type: 'note', value: LONG_NOTE },
        ],
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
        record('the outbound reveal gate renders', state === 'reveal', `state=${state}`);
        for (const theme of THEMES) {
          await setTheme(cdp, sessionId, theme);
          for (const viewport of Object.keys(VIEWPORTS)) {
            await shoot(cdp, sessionId, viewport, join(outDir, `outbound-gate-${viewport}-${theme}.png`));
          }
        }
        await setTheme(cdp, sessionId, 'dark');
        const gateZoom = await zoomed(cdp, sessionId, join(outDir, 'outbound-gate-zoom200-dark.png'));
        record('nothing overflows or is clipped at 200% zoom: outbound gate', gateZoom.overflow <= 0 && gateZoom.clipped.length === 0,
          `overflow=${gateZoom.overflow}px clipped=${JSON.stringify(gateZoom.clipped)}`);
        const gateLayout = await phoneLayout(cdp, sessionId, '#reveal-open');
        record('Reveal is inside the first 390x844 screen, with no overflow or clipping',
          gateLayout.overflow <= 0 && gateLayout.clipped.length === 0 && gateLayout.actionBottom <= gateLayout.height,
          `overflow=${gateLayout.overflow}px reveal-bottom=${gateLayout.actionBottom}px of ${gateLayout.height}px`);

        // One wrong code: the adjacent note must say so and count down.
        const wrong = created.code === '000' ? '111' : '000';
        const afterWrong = await evaluate(cdp, sessionId, `
          (async () => {
            document.getElementById('reveal-code').value = ${JSON.stringify(wrong)};
            document.getElementById('reveal-open').click();
            for (let i = 0; i < 50; i += 1) {
              if (/not right/.test(document.getElementById('reveal-note').textContent)) break;
              await new Promise((r) => setTimeout(r, 100));
            }
            return document.getElementById('reveal-note').textContent;
          })()
        `);
        record('a wrong code is refused beside the field', /not right/.test(afterWrong) && /2 tries/.test(afterWrong), afterWrong);
        for (const theme of THEMES) {
          await setTheme(cdp, sessionId, theme);
          await shoot(cdp, sessionId, 'phone', join(outDir, `outbound-wrong-code-phone-${theme}.png`));
        }
        await setTheme(cdp, sessionId, 'dark');
        await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

        const revealed = await evaluate(cdp, sessionId, `
          (async () => {
            document.getElementById('reveal-code').value = ${JSON.stringify(created.code)};
            document.getElementById('reveal-open').click();
            for (let i = 0; i < 80; i += 1) {
              if (document.getElementById('app').dataset.state === 'revealed') break;
              await new Promise((r) => setTimeout(r, 100));
            }
            const values = [...document.querySelectorAll('#revealed-fields .field-value')];
            return {
              state: document.getElementById('app').dataset.state,
              masked: values.filter((node) => node.classList.contains('masked')).length,
              rows: values.length,
              secretShown: values.some((node) => node.textContent.includes('not-a-real-token')),
            };
          })()
        `);
        record('the right code reveals every row with the secret masked',
          revealed.state === 'revealed' && revealed.rows === 4 && revealed.masked === 1 && !revealed.secretShown,
          JSON.stringify(revealed));
        for (const theme of THEMES) {
          await setTheme(cdp, sessionId, theme);
          for (const viewport of Object.keys(VIEWPORTS)) {
            await shoot(cdp, sessionId, viewport, join(outDir, `outbound-revealed-masked-${viewport}-${theme}.png`));
          }
        }
        const shown = await evaluate(cdp, sessionId, `
          (() => {
            const toggle = [...document.querySelectorAll('#revealed-fields button')].find((b) => b.textContent === 'Show');
            toggle.click();
            const values = [...document.querySelectorAll('#revealed-fields .field-value')];
            return { toggle: toggle.textContent, pressed: toggle.getAttribute('aria-pressed'),
                     secretShown: values.some((node) => node.textContent.includes('not-a-real-token')) };
          })()
        `);
        record('Show reveals only on request, and Copy stays a separate control',
          shown.toggle === 'Hide' && shown.pressed === 'true' && shown.secretShown, JSON.stringify(shown));
        for (const theme of THEMES) {
          await setTheme(cdp, sessionId, theme);
          await shoot(cdp, sessionId, 'phone', join(outDir, `outbound-revealed-shown-phone-${theme}.png`));
        }
        await setTheme(cdp, sessionId, 'dark');
        const sticky = await stickyArt(cdp, sessionId, join(outDir, 'outbound-revealed-scrolled-desktop-dark.png'));
        record('on a long wide screen the art stays centred in the window after scrolling',
          sticky.scrollable > 100 && sticky.scrollY > 100
            && Math.abs(sticky.artTop - sticky.expectedTop) <= 1 && sticky.artBottom <= sticky.windowHeight,
          JSON.stringify(sticky));
        const revealedZoom = await zoomed(cdp, sessionId, join(outDir, 'outbound-revealed-zoom200-dark.png'));
        record('nothing overflows or is clipped at 200% zoom: revealed values', revealedZoom.overflow <= 0 && revealedZoom.clipped.length === 0,
          `overflow=${revealedZoom.overflow}px clipped=${JSON.stringify(revealedZoom.clipped)}`);
        const revealedLayout = await phoneLayout(cdp, sessionId, '#revealed-note');
        record('the revealed values do not widen or clip at 390px',
          revealedLayout.overflow <= 0 && revealedLayout.clipped.length === 0,
          `overflow=${revealedLayout.overflow}px clipped=${JSON.stringify(revealedLayout.clipped)}`);
      } else {
        record('the outbound reveal gate renders', false, `could not mint an outbound drop: ${JSON.stringify(created)}`);
      }
    }

    {
      const created = await control({ op: 'create', payload_kind: 'universal', ttl_seconds: 900 });
      await control({ op: 'claim', handoff_id: created.handoff_id }).catch(() => {});
      await navigate(cdp, sessionId, `${broker.baseUrl}/#${'z'.repeat(22)}`);
      const state = await evaluate(cdp, sessionId, "document.getElementById('app').dataset.state");
      record('an unknown capability shows the unavailable screen', state === 'unavailable', `state=${state}`);
      for (const theme of THEMES) {
        await setTheme(cdp, sessionId, theme);
        for (const viewport of Object.keys(VIEWPORTS)) {
          await shoot(cdp, sessionId, viewport, join(outDir, `unavailable-${viewport}-${theme}.png`));
        }
      }
      await setTheme(cdp, sessionId, 'dark');
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
