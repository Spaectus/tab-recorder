// End-to-end test for the M4A export, run INSIDE the real loaded extension.
//
// Why so involved: the conversion runs in the extension's offscreen document
// (its own origin, MV3 CSP, the real module graph offscreen.js → m4a.js →
// mp4-muxer.mjs). offscreen.html is not web-accessible, so it can only be opened
// by the extension itself. We therefore launch Chrome with a debug port, drive
// the extension's service worker over raw CDP to open offscreen.html in a tab,
// then run the full pipeline in that page and validate the produced .m4a.
//
// Requires Google Chrome (proprietary AAC encoder). Run:
//   node test/extension-m4a.test.mjs

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT   = path.resolve(__dirname, '..');
const PORT      = 9333;
const CHROME    = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Minimal CDP client over a single target's WebSocket ──────────────────────
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    }),
    close: () => ws.close(),
  };
}

async function getTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

// Evaluate an async function in a target, returning its resolved value by value.
async function evalIn(wsUrl, fnSource) {
  const c = cdp(wsUrl);
  await c.ready;
  await c.send('Runtime.enable');
  const { result, exceptionDetails } = await c.send('Runtime.evaluate', {
    expression: `(${fnSource})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  c.close();
  if (exceptionDetails) {
    throw new Error('eval threw: ' + (exceptionDetails.exception?.description || exceptionDetails.text));
  }
  return result.value;
}

// ── The pipeline that runs in the offscreen page ─────────────────────────────
const pipelineSrc = async () => {
  const out = { stage: 'start', hasAudioEncoder: typeof AudioEncoder !== 'undefined' };
  let encodeM4a;
  try {
    ({ encodeM4a } = await import('./m4a.js'));
    out.moduleOk = typeof encodeM4a === 'function';
  } catch (e) { out.stage = 'import'; out.error = String(e && e.stack || e); return out; }

  try {
    const recCtx = new AudioContext();
    const dest = recCtx.createMediaStreamDestination();
    const osc = recCtx.createOscillator();
    osc.frequency.value = 440; osc.connect(dest); osc.start();
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(); await new Promise(r => setTimeout(r, 1200)); rec.stop(); await stopped;
    osc.stop(); await recCtx.close();
    const webmBlob = new Blob(chunks, { type: 'audio/webm' });

    const decCtx = new AudioContext({ sampleRate: 48000 });
    const audioBuffer = await decCtx.decodeAudioData(await webmBlob.arrayBuffer());
    await decCtx.close();

    const mp4 = await encodeM4a(audioBuffer);
    const bytes = new Uint8Array(mp4);
    out.ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    out.mp4Size = mp4.byteLength;
    out.webmSize = webmBlob.size;

    const v = new AudioContext();
    const decoded = await v.decodeAudioData(mp4.slice(0));
    out.outDuration = decoded.duration;
    out.outRate = decoded.sampleRate;
    await v.close();
    out.stage = 'ok';
  } catch (e) { out.stage = 'convert'; out.error = String(e && e.stack || e); }
  return out;
};

// ── Driver ───────────────────────────────────────────────────────────────────
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabrec-ext-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDataDir}`,
  `--disable-extensions-except=${PROJECT}`,
  `--load-extension=${PROJECT}`,
  '--headless=new',
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  'about:blank',
], { stdio: 'ignore' });

let failed = false;
try {
  // Wait for the debug endpoint.
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; }
    catch { await sleep(250); }
  }

  // Find OUR extension's background context by manifest name (Chrome's own
  // component extensions also show up as extension targets). It registers on
  // install; poll until it appears.
  let ours = null;
  for (let i = 0; i < 40 && !ours; i++) {
    const targets = await getTargets();
    const exts = targets.filter(t => t.url.startsWith('chrome-extension://') && t.webSocketDebuggerUrl &&
      (t.type === 'service_worker' || t.type === 'background_page'));
    for (const t of exts) {
      try {
        const name = await evalIn(t.webSocketDebuggerUrl, `() => chrome.runtime.getManifest().name`);
        if (name === 'Tab Audio Recorder') { ours = t; break; }
      } catch { /* context busy — retry */ }
    }
    if (!ours) await sleep(250);
  }
  if (!ours) {
    // Chrome 137+ disabled the --load-extension command-line switch, so the
    // unpacked extension can't be auto-loaded for testing. This is an automation
    // limitation, not a code failure — the encoder itself is covered by
    // m4a-conversion.test.mjs. Verify the in-extension path manually (see README).
    console.log('\n⏭️  SKIP — could not auto-load the unpacked extension ' +
      '(Chrome 137+ blocks --load-extension). Run m4a-conversion.test.mjs for the encoder, ' +
      'and load the extension manually to verify the offscreen path.');
    process.exitCode = 0;
    chrome.kill();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    process.exit(0);
  }
  const extId = new URL(ours.url).host;
  console.log('Extension id:', extId);

  // Drive the extension to open its own offscreen.html as a tab (allowed for the
  // extension itself; not navigable from outside since it isn't web-accessible).
  await evalIn(ours.webSocketDebuggerUrl,
    `async () => { await chrome.tabs.create({ url: chrome.runtime.getURL('offscreen.html') }); }`);

  // Find the offscreen page target.
  let pageTarget = null;
  for (let i = 0; i < 40 && !pageTarget; i++) {
    const targets = await getTargets();
    pageTarget = targets.find(t => t.type === 'page' && t.url.includes('offscreen.html') && t.webSocketDebuggerUrl);
    if (!pageTarget) await sleep(250);
  }
  if (!pageTarget) throw new Error('offscreen.html tab never opened');

  const r = await evalIn(pageTarget.webSocketDebuggerUrl, pipelineSrc.toString());
  console.log('Pipeline result:', JSON.stringify(r, null, 2));

  const assert = (c, m) => { if (!c) throw new Error('ASSERT FAILED: ' + m); };
  assert(r.hasAudioEncoder, 'WebCodecs AudioEncoder must exist in the offscreen document');
  assert(r.moduleOk, 'm4a.js module graph must load under MV3 CSP');
  assert(r.stage === 'ok', `pipeline failed at "${r.stage}": ${r.error}`);
  assert(r.mp4Size > 1000, `M4A must be a real file, got ${r.mp4Size} bytes (bug produced 0 KB)`);
  assert(r.ftyp === 'ftyp', `MP4 must start with ftyp, got "${r.ftyp}"`);
  assert(r.outDuration > 0, 'produced M4A must decode back to audio');
  assert(r.outRate === 48000, `expected 48k, got ${r.outRate}`);

  console.log('\n✅ PASS — M4A conversion works inside the real loaded extension (offscreen origin).');
} catch (e) {
  failed = true;
  console.error('\n❌ FAIL —', e.message);
} finally {
  chrome.kill();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
process.exitCode = failed ? 1 : 0;
