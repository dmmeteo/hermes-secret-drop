// Driving a real browser engine over CDP, with no browser-automation dependency.
//
// Extracted from `scripts/form-screenshots.mjs` when the declarative form engine needed
// the same machinery: two scripts sharing one implementation beats two copies drifting
// apart, and the alternative — importing from a script whose module body runs `main()` —
// would have started a browser as a side effect of an import.
//
// Why no Playwright or Puppeteer, restated because it is the first question a reader
// has: CONTRIBUTING.md asks what breaks without a dependency, and the answer is nothing.
// Chrome speaks CDP over a WebSocket, Node 22 has a WebSocket client built in, and the
// handful of commands below is the whole requirement.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Every screenshot this process has written, so a run can enumerate its own output. */
export const written = [];

export const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** Desktop and a small phone. The phone is the one that finds layout bugs. */
export const VIEWPORTS = {
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
export const THEMES = ['dark', 'light'];

/**
 * The check ledger, shared so both runs report the same way.
 *
 * A screenshot proves nothing on its own — somebody has to look at it — so every run
 * here also *asserts*, and these are the assertions. One per line as they happen, and a
 * count at the end that sets the exit code.
 */
export const results = [];
export const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Prints `N/M browser checks passed` and sets a non-zero exit code on any failure. */
export function summarize() {
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  if (failed.length) {
    console.log('failed:');
    for (const entry of failed) console.log(`  - ${entry.name} ${entry.detail}`);
    process.exitCode = 1;
  }
  return failed.length === 0;
}

/** `--out DIR`, or the caller's default. */
export function outDirFrom(fallback) {
  const args = process.argv.slice(2);
  return args.includes('--out') ? args[args.indexOf('--out') + 1] : fallback;
}

// ── a minimal CDP client ──────────────────────────────────────────────────────
//
// One WebSocket to the browser, `flatten: true` so page sessions multiplex over it,
// and a monotonic id per command. Everything below is request/response except the
// handful of events `waitFor` parks on.
export function connectCdp(url) {
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

export async function launchChrome(userDataDir) {
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
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-8000); });
  child.on('error', (error) => { diagnostics = error.message; });

  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (existsSync(portFile)) {
      const [port] = (await readFile(portFile, 'utf8')).split('\n');
      if (port) return { child, port: Number(port), binary };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`chrome did not publish a devtools port: ${diagnostics.trim()}`);
}

/** One page, attached and with Page events on. */
export async function openPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

export async function setTheme(cdp, sessionId, theme) {
  await cdp.send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: theme }] },
    sessionId,
  );
}

export async function navigate(cdp, sessionId, url) {
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

export async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'evaluate threw');
  return result.value;
}

/** Every PNG this run wrote, so the count in a report is derived and not recalled. */

export async function shoot(cdp, sessionId, viewport, file) {
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
