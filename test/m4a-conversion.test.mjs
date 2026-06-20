// Tests both M4A export paths the offscreen engine uses, in the REAL installed
// Chrome (Playwright, channel 'chrome' — needed for the proprietary AAC codec):
//
//   PRIMARY : a live MediaRecorder('audio/mp4;codecs=mp4a.40.2') off the capture
//             stream — same mechanism as the WebM, no decode/re-encode.
//   FALLBACK: encodeM4a() from m4a.js (WebCodecs AudioEncoder + mp4-muxer), used
//             on older Chrome that can't record audio/mp4 directly.
//
// Each path must yield a non-zero, well-formed MP4 that decodes back to audio of
// the right duration — i.e. NOT the 0 KB / corrupt file the old lamejs produced.
//
// Run: node test/m4a-conversion.test.mjs   (Playwright must be importable; set
//      PLAYWRIGHT_DIR if it lives outside the project)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT   = path.resolve(__dirname, '..');
const require   = createRequire(pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR || PROJECT, 'noop.js')));
const { chromium } = require('playwright');

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.html': 'text/html', '.css': 'text/css', '.json': 'application/json',
};

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/__harness') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><meta charset=utf-8><title>harness</title>');
    }
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(PROJECT, rel);
    if (!file.startsWith(PROJECT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// NOTE: these run inside the page via page.evaluate, so they must be fully
// self-contained (no references to module-scope helpers).

// PRIMARY: live audio/mp4 MediaRecorder.
async function runPrimary() {
  const validate = async (buf) => {
    const b = new Uint8Array(buf);
    const ftyp = String.fromCharCode(b[4], b[5], b[6], b[7]);
    const v = new AudioContext();
    const dec = await v.decodeAudioData(buf.slice(0));
    const out = { size: buf.byteLength, ftyp, duration: dec.duration, sampleRate: dec.sampleRate };
    await v.close();
    return out;
  };
  const MIME = 'audio/mp4;codecs=mp4a.40.2';
  if (!MediaRecorder.isTypeSupported(MIME)) return { supported: false };
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440; osc.connect(dest); osc.start();
  const rec = new MediaRecorder(dest.stream, { mimeType: MIME, audioBitsPerSecond: 128000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(1000); await new Promise(r => setTimeout(r, 1300)); rec.stop(); await stopped;
  osc.stop(); await ctx.close();
  const blob = new Blob(chunks, { type: 'audio/mp4' });
  return { supported: true, ...(await validate(await blob.arrayBuffer())) };
}

// FALLBACK: encodeM4a from the extension's own module.
async function runFallback() {
  const validate = async (buf) => {
    const b = new Uint8Array(buf);
    const ftyp = String.fromCharCode(b[4], b[5], b[6], b[7]);
    const v = new AudioContext();
    const dec = await v.decodeAudioData(buf.slice(0));
    const out = { size: buf.byteLength, ftyp, duration: dec.duration, sampleRate: dec.sampleRate };
    await v.close();
    return out;
  };
  // Record a WebM/Opus tone, then decode + re-encode via the module under test.
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440; osc.connect(dest); osc.start();
  const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
  const wchunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) wchunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(); await new Promise(r => setTimeout(r, 1300)); rec.stop(); await stopped;
  osc.stop(); await ctx.close();
  const webm = new Blob(wchunks, { type: 'audio/webm' });

  const { encodeM4a } = await import('/m4a.js');
  const decCtx = new AudioContext({ sampleRate: 48000 });
  const audioBuffer = await decCtx.decodeAudioData(await webm.arrayBuffer());
  await decCtx.close();
  const buf = await encodeM4a(audioBuffer);
  return validate(buf);
}

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }
function checkM4a(label, r) {
  assert(r.size > 1000, `${label}: M4A should be a real file, got ${r.size} bytes (old bug = 0 KB)`);
  assert(r.ftyp === 'ftyp', `${label}: MP4 must start with ftyp, got "${r.ftyp}"`);
  assert(r.duration > 0.8 && r.duration < 2, `${label}: duration should be ~1.3s, got ${r.duration?.toFixed?.(2)}s`);
  assert(r.sampleRate === 48000, `${label}: expected 48k, got ${r.sampleRate}`);
}

const server = await startServer();
const port = server.address().port;
let browser;
const pageErrors = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('favicon') && !t.includes('Failed to load resource')) pageErrors.push('console.error: ' + t);
  });
  await page.goto(`http://127.0.0.1:${port}/__harness`);

  const primary = await page.evaluate(runPrimary);
  console.log('PRIMARY (live audio/mp4):', JSON.stringify(primary));
  assert(primary.supported, 'Chrome should support live audio/mp4 recording (the primary path)');
  checkM4a('primary', primary);

  const fallback = await page.evaluate(runFallback);
  console.log('FALLBACK (WebCodecs encodeM4a):', JSON.stringify(fallback));
  checkM4a('fallback', fallback);

  if (pageErrors.length) throw new Error('unexpected page errors: ' + pageErrors.join(' | '));
  console.log('\n✅ PASS — both M4A paths produce valid, non-zero, decodable files.');
} catch (e) {
  console.error('\n❌ FAIL —', e.message);
  if (pageErrors.length) console.error('Page errors:', pageErrors);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
