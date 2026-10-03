// Real Chrome + production bundle + local broker, faulted at the HTTP seam.
// Run after npm run build; no capability, key or payload goes into the evidence.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestBroker, createOutboundDrop, splitHandoffUrl } from '../test/helpers/harness.js';
import { connectCdp, launchChrome, openPage, navigate, evaluate, setTheme, shoot,
  VIEWPORTS, THEMES, record, summarize, results, outDirFrom } from './lib/cdp.mjs';

const out = outDirFrom('/tmp/drop-metadata-retry');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateExpression = `document.getElementById('app').dataset.state`;
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'drop-retry-chrome-'));
const broker = await startTestBroker();
let chrome, cdp;
try {
  chrome = await launchChrome(profile);
  const version = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json();
  console.log(`Real browser: ${version.Browser}; local isolated broker`);
  cdp = connectCdp(version.webSocketDebuggerUrl);
  await cdp.ready;
  const { sessionId: session } = await openPage(cdp);
  await cdp.send('Network.enable', {}, session);
  const network = [];
  const errors = [];
  cdp.on('Network.requestWillBeSent', ({ request }, from) => {
    if (from === session && new URL(request.url).pathname.startsWith('/api/')) network.push(request);
  });
  cdp.on('Runtime.exceptionThrown', (_event, from) => { if (from === session) errors.push('exception'); });
  let mode = 'pass';
  let held = null;
  cdp.on('Fetch.requestPaused', async ({ requestId }, from) => {
    if (from !== session) return;
    try {
      if (mode === 'hang' || mode === 'hold') { held = requestId; return; }
      if (mode === 'network' || mode === 'offline') {
        if (mode === 'offline') await cdp.send('Network.emulateNetworkConditions', {
          offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        }, session);
        await cdp.send('Fetch.failRequest', { requestId, errorReason: mode === 'offline' ? 'InternetDisconnected' : 'Failed' }, session);
      } else if (mode === 'malformed' || typeof mode === 'number') {
        await cdp.send('Fetch.fulfillRequest', {
          requestId, responseCode: typeof mode === 'number' ? mode : 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(mode === 'malformed' ? '<proxy error>' : '{}').toString('base64'),
        }, session);
      } else await cdp.send('Fetch.continueRequest', { requestId }, session);
    } catch { /* An aborted request may have already left the Fetch domain. */ }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*api/*metadata' }] }, session);
  const state = () => evaluate(cdp, session, stateExpression);
  async function waitState(expected, timeout = 2500) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await state() === expected) return true;
      await pause(50);
    }
    return false;
  }
  async function online() {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }, session);
  }
  async function click() {
    await evaluate(cdp, session, `document.getElementById('check-retry').click()`);
  }
  const logs = [];
  for (const direction of ['inbound', 'outbound']) {
    const path = direction === 'inbound' ? '/api/metadata' : '/api/reveal/metadata';
    const ready = direction === 'inbound' ? 'form' : 'reveal';
    const mint = async () => {
      if (direction === 'outbound') {
        const drop = await createOutboundDrop(broker, { plaintext: 'synthetic retry canary' });
        return { hash: `#${drop.fragment}`, capability: drop.capability, key: drop.key, id: drop.id, drop };
      }
      const created = await broker.control({ op: 'create' });
      const { capability } = splitHandoffUrl(created.url);
      return { hash: `#${capability}`, capability, id: created.handoff_id };
    };
    const snapshot = (drop) => direction === 'inbound'
      ? broker.testSnapshot(drop.id) : broker.testOutboundSnapshot(drop.id);
    for (const fault of ['network', 'offline', 408, 429, 503, 'malformed', 'hang']) {
      const drop = await mint();
      const before = snapshot(drop);
      const first = network.length;
      mode = fault;
      held = null;
      const began = Date.now();
      await navigate(cdp, session, `${broker.baseUrl}/${drop.hash}`);
      const failed = await waitState('check-failed', fault === 'hang' ? 22_000 : 2500);
      record(`${direction} ${fault}: bounded failure screen`, failed, `elapsed ${Date.now() - began}ms`);
      // Fail fast in RED, before trying a control that the old build doesn't have.
      assert.ok(failed, 'metadata failure must leave loading');
      await online();
      held = null;
      mode = 'hold';

      if (fault === 'network') {
        for (const viewport of Object.keys(VIEWPORTS)) for (const theme of THEMES) {
          await setTheme(cdp, session, theme);
          await shoot(cdp, session, viewport, join(out, `${direction}-check-failed-${viewport}-${theme}.png`));
          const layout = await evaluate(cdp, session, `(() => {
            const section = document.getElementById('check-failed');
            const box = section.getBoundingClientRect();
            const button = document.getElementById('check-retry').getBoundingClientRect();
            return { overflow: document.documentElement.scrollWidth > innerWidth,
              clipped: [...section.querySelectorAll('*')].some(el => {
                const r = el.getBoundingClientRect(); return r.width && (r.left < box.left - 1 || r.right > box.right + 1);
              }), target: button.height >= 44, fits: button.bottom <= innerHeight };
          })()`);
          record(`${direction} ${viewport} ${theme}: layout and touch target`, !layout.overflow && !layout.clipped && layout.target && layout.fits);
          const tree = await cdp.send('Accessibility.getFullAXTree', {}, session);
          record(`${direction} ${viewport} ${theme}: Retry accessible name`, tree.nodes.some(n => n.role?.value === 'button' && n.name?.value === 'Retry'));
        }
        await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORTS.phone, width: 195, deviceScaleFactor: 4 }, session);
        const zoom = await evaluate(cdp, session, `(() => {
          const box = document.getElementById('check-failed').getBoundingClientRect();
          return [...document.querySelectorAll('#check-failed *')].every(el => {
            const r = el.getBoundingClientRect(); return !r.width || (r.left >= box.left - 1 && r.right <= box.right + 1);
          }) && document.documentElement.scrollWidth <= innerWidth;
        })()`);
        record(`${direction}: 200% narrow zoom fits its column`, zoom);
        await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORTS.phone, session);
        for (let i = 0; i < 8; i++) {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, session);
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, session);
          if (await evaluate(cdp, session, `document.activeElement.id === 'check-retry'`)) break;
        }
        const focus = await evaluate(cdp, session, `document.activeElement.id === 'check-retry' && getComputedStyle(document.activeElement).outlineStyle !== 'none'`);
        record(`${direction}: keyboard reaches Retry with visible focus`, focus);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
      } else if (fault === 'offline') {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true }, session);
        const point = await evaluate(cdp, session, `(() => { const r = document.getElementById('check-retry').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }, session);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, session);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }, session);
      } else await click();
      for (let i = 0; i < 40 && !held; i++) await pause(50);
      record(`${direction} ${fault}: explicit Retry sends metadata`, !!held);
      assert.ok(held, 'Retry did not send a metadata request');
      await click(); await click();
      await pause(100);
      record(`${direction} ${fault}: duplicate clicks suppressed`, network.length - first === 2);
      const busy = await evaluate(cdp, session, `(() => {
        const b = document.getElementById('check-retry'); return b.textContent === 'Checking…' && b.getAttribute('aria-disabled') === 'true';
      })()`);
      record(`${direction} ${fault}: accessible busy state`, busy);
      if (fault === 'network') {
        for (const viewport of Object.keys(VIEWPORTS)) for (const theme of THEMES) {
          await setTheme(cdp, session, theme);
          await shoot(cdp, session, viewport, join(out, `${direction}-checking-${viewport}-${theme}.png`));
        }
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, session);
        record(`${direction}: reduced motion removes Retry transitions`, await evaluate(cdp, session, `getComputedStyle(document.getElementById('check-retry')).transitionDuration === '0s'`));
      }
      const visible = await evaluate(cdp, session, 'document.body.innerText');
      record(`${direction} ${fault}: fragment material absent from visible DOM`, !visible.includes(drop.capability) && (!drop.key || !visible.includes(drop.key)));
      mode = 'pass';
      await cdp.send('Fetch.continueRequest', { requestId: held }, session);
      held = null;
      record(`${direction} ${fault}: Retry succeeds`, await waitState(ready));
      const after = snapshot(drop);
      record(`${direction} ${fault}: broker state and budget preserved`, after.state === before.state &&
        (direction === 'inbound' || (after.attemptsRemaining === 3 && !after.claimed && after.hasCiphertext)));
      const requests = network.slice(first);
      record(`${direction} ${fault}: SAME-link metadata only, no body`, requests.length === 2 && requests.every(r => {
        const headers = Object.fromEntries(Object.entries(r.headers).map(([k,v]) => [k.toLowerCase(), v]));
        return new URL(r.url).pathname === path && r.method === 'POST' && !r.postData &&
          headers['x-handoff-capability'] === drop.capability && !r.url.includes('#');
      }));
      logs.push({ direction, fault, requests: requests.map(r => ({ method: r.method, path: new URL(r.url).pathname })) });
    }

    for (const terminal of ['unknown', 'expired', 'spent']) {
      const drop = await mint();
      if (terminal === 'unknown') drop.hash = direction === 'inbound' ? `#${'A'.repeat(22)}` : `#r.${'A'.repeat(22)}.${drop.key}`;
      if (terminal === 'expired') {
        if (direction === 'outbound') broker.testSetOutboundExpiry(drop.id, Date.now() - 1);
        else broker.broker.testSetExpiry(drop.id, Date.now() - 1);
      }
      if (terminal === 'spent') {
        if (direction === 'outbound') await drop.drop.reveal();
        else {
          const { sendSecret } = await import('../src/client/handoff-client.js');
          await sendSecret({ capability: drop.capability, plaintext: 'synthetic used drop', origin: broker.baseUrl });
        }
      }
      mode = 503;
      const first = network.length;
      await navigate(cdp, session, `${broker.baseUrl}/${drop.hash}`);
      assert.ok(await waitState('check-failed'));
      mode = 'pass';
      await click();
      record(`${direction} ${terminal}: Retry reaches generic unavailable`, await waitState('unavailable'));
      record(`${direction} ${terminal}: no state-changing browser requests`, network.slice(first).every(r => new URL(r.url).pathname === path));
    }
  }
  record('no unhandled browser exceptions', errors.length === 0, `${errors.length} exceptions`);
  await writeFile(join(out, 'request-ledger.json'), JSON.stringify(logs, null, 2));
} catch (error) {
  console.error(`metadata browser run failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
  summarize();
  cdp?.close();
  if (chrome) {
    const exited = new Promise(resolve => chrome.child.once('exit', resolve));
    chrome.child.kill('SIGTERM');
    await Promise.race([exited, pause(5000)]);
  }
  await broker.stop();
  await rm(profile, { recursive: true, force: true });
}
