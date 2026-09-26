// Recording engine. Runs in the offscreen document, which persists for the
// lifetime of a recording.
//
// IMPORTANT: offscreen documents do NOT have chrome.storage — only
// chrome.runtime (messaging) and IndexedDB. So this file talks to the service
// worker over messages, and the service worker owns all chrome.storage access:
//   offscreen -> { evt: 'ready' | 'status' | 'live' } -> background
//   background -> { action: 'startRecordingOffscreen' | 'autoPause' | ... } -> offscreen
//
// Auto-pause is driven by the SERVICE WORKER watching the tab's audio indicator
// (tab.audible = the speaker icon on the tab). The SW sends 'autoPause' /
// 'autoResume'; this engine just pauses/resumes the recorder, never overriding
// a manual pause.
//
//   tab stream ─┬─> AudioContext.destination   (so the tab stays audible)
//               └─> AnalyserNode               (waveform only)
//   tab stream ───> MediaRecorder(webm/opus)   (encoding, off the main thread)
//
// MediaRecorder hands us independent Blob chunks (no buffer aliasing). Every
// ~10s we commit the full blob to the chosen file and close() it — close is
// what actually flushes to disk, so a crash loses at most one commit interval.

import { getHandle, M4A_KEY } from './idb.js';
import { encodeM4a, AAC_SAMPLE_RATE } from './m4a.js';

const COMMIT_INTERVAL = 10_000; // ms — how often we flush to disk
const TICK_INTERVAL   = 100;    // ms — waveform / timer refresh
const BANDS           = 10;     // waveform bars
const BITRATE         = 128_000;
const M4A_MIME        = 'audio/mp4;codecs=mp4a.40.2'; // AAC-LC in MP4, for the automatic M4A copy

let audioCtx = null, rawStream = null, source = null, analyser = null, recorder = null;
let m4aRecorder = null;  // second recorder, encodes the M4A copy live
let m4aChunks = [];       // buffered audio/mp4 chunks (written when recording ends)
let fileHandle = null;
let chunks = [];
let commitTimer = null, tickTimer = null;
let freqData = null;

let manuallyPaused = false;
let autoPaused = false;
let muted = false; // when true, the captured tab is not played back locally (recording continues)

let startedAt = 0;
let pausedAccumMs = 0;   // total time spent paused
let pauseStartedAt = 0;  // start of the current pause (0 when not paused)
let committing = false;
let stopping = false;
let active = false;      // a recording session is live or being set up
let permissionLost = false; // write grant died with the UI window that requested it

let m4aSupported = false; // set by checkM4aSupport on load

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.action) return; // UI uses .cmd, background events use .evt
  switch (msg.action) {
    case 'startRecordingOffscreen':
      if (!active) { active = true; muted = !!msg.muted; start(msg.streamId); }
      break;
    case 'stopRecordingOffscreen':   stop(msg.m4a !== false); break;
    case 'pauseRecordingOffscreen':  manualPause();    break;
    case 'resumeRecordingOffscreen': manualResume();   break;
    case 'autoPause':   if (!manuallyPaused && !autoPaused) doAutoPause(); break;
    case 'autoResume':  if (autoPaused) doAutoResume();                    break;
    case 'setMute':     setMute(!!msg.muted);                              break;
    case 'recheckPermission': recheckPermission();                         break;
  }
});

// Check M4A support and notify background
async function checkM4aSupport() {
  if (!MediaRecorder.isTypeSupported(M4A_MIME)) {
    sendEvt({ m4aSupport: false });
    return false;
  }
  try {
    const config = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 };
    const supported = await AudioEncoder.isConfigSupported(config);
    const ok = supported?.supported === true;
    sendEvt({ m4aSupport: ok });
    return ok;
  } catch {
    sendEvt({ m4aSupport: false });
    return false;
  }
}

checkM4aSupport().then(ok => { m4aSupported = ok; });

// Tell the service worker we're alive so it can hand us the start message
// without racing this module's listener registration.
sendEvt({ evt: 'ready' });

function sendEvt(payload)            { chrome.runtime.sendMessage(payload).catch(() => {}); }
function sendStatus(status, error = '', extra = {}) {
  sendEvt({ evt: 'status', status, error: error || '', permissionLost, ...extra });
}
function sendLive(waveform, elapsed) { sendEvt({ evt: 'live', waveform, elapsedMs: elapsed }); }

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function start(streamId) {
  try {
    fileHandle = await getHandle(); // IndexedDB is available in offscreen docs
    if (!fileHandle) return fail('No save location was set.');

    // Write permission was granted by the picker in the UI; we can only verify
    // here (an offscreen document has no user gesture to request it).
    if (fileHandle.queryPermission) {
      const perm = await fileHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return fail('No permission to write the chosen file.');
    }

    rawStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    });
  } catch (e) {
    return fail('Could not start capture: ' + (e?.message || e));
  }

  // Keep the tab audible + feed the analyser. The MediaRecorder reads rawStream
  // directly, so muting (disconnecting from destination) silences local playback
  // without affecting what gets recorded.
  audioCtx = new AudioContext();
  await audioCtx.resume();
  source = audioCtx.createMediaStreamSource(rawStream);
  if (!muted) source.connect(audioCtx.destination);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  freqData = new Uint8Array(analyser.frequencyBinCount);

  // Pick the best supported webm/opus profile.
  let mime = '';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus';
  else if (MediaRecorder.isTypeSupported('audio/webm'))        mime = 'audio/webm';
  try {
    recorder = mime
      ? new MediaRecorder(rawStream, { mimeType: mime, audioBitsPerSecond: BITRATE })
      : new MediaRecorder(rawStream);
  } catch (e) {
    return fail('Recorder init failed: ' + (e?.message || e));
  }

  chunks = [];
  m4aChunks = [];
  manuallyPaused = autoPaused = false;
  pausedAccumMs = 0; pauseStartedAt = 0;
  startedAt = Date.now();
  stopping = false;

  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onerror = (e) => fail('Recorder error: ' + (e?.error?.message || 'unknown'));

  // Second recorder for the M4A copy. It encodes AAC/MP4 live off the same
  // stream — the most reliable route (decode-then-reencode of the WebM was
  // fragile). The .m4a destination was created at start alongside the .webm,
  // and the copy is written automatically on EVERY end of recording — manual
  // stop, tab close, or an error (see salvageM4a). It runs CONTINUOUSLY and
  // is never paused: MP4 tolerates pause/resume gaps poorly, and a complete valid
  // file matters more than mirroring the WebM's skipped spans for an extra copy.
  m4aRecorder = null;
  if (m4aSupported && MediaRecorder.isTypeSupported(M4A_MIME)) {
    try {
      m4aRecorder = new MediaRecorder(rawStream, { mimeType: M4A_MIME, audioBitsPerSecond: BITRATE });
      m4aRecorder.ondataavailable = (e) => { if (e.data && e.data.size) m4aChunks.push(e.data); };
      // A failure here must not kill the recording — the WebM is the primary file.
      // Drop the partial buffer so Stop & Save cleanly re-encodes the full WebM
      // instead of writing a truncated M4A.
      m4aRecorder.onerror = () => { tryCall(() => m4aRecorder.stop()); m4aRecorder = null; m4aChunks = []; };
    } catch { m4aRecorder = null; }
  }

  // If the captured tab is closed, its track ends — finalize what we have.
  rawStream.getAudioTracks().forEach(t => t.addEventListener('ended', () => stop()));

  recorder.start(1000); // emit a chunk every 1s
  if (m4aRecorder) tryCall(() => m4aRecorder.start(1000));

  commitTimer = setInterval(commit, COMMIT_INTERVAL);
  tickTimer   = setInterval(tick, TICK_INTERVAL);

  sendStatus('recording');
}

async function stop(convertM4a = true) {
  if (stopping) return;
  stopping = true;
  clearInterval(commitTimer); commitTimer = null;
  clearInterval(tickTimer);   tickTimer = null;

  if (recorder && recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
      try { recorder.stop(); } catch { resolve(); }
    });
  }

  // Flush the M4A recorder too, so its final chunk lands before we read the buffer.
  if (m4aRecorder && m4aRecorder.state !== 'inactive') {
    await new Promise((resolve) => {
      m4aRecorder.addEventListener('stop', resolve, { once: true });
      try { m4aRecorder.stop(); } catch { resolve(); }
    });
  }

  // Snapshot the recorded audio before the final commit: if that commit fails
  // (e.g. write permission lost), fail() tears down the buffers — the M4A must
  // already be captured by then. Blobs reference the existing chunk data (no
  // copy), so keeping both around briefly is cheap.
  const m4aBlob  = m4aChunks.length ? new Blob(m4aChunks, { type: 'audio/mp4' })  : null;
  const webmBlob = chunks.length    ? new Blob(chunks,    { type: 'audio/webm' }) : null;

  // Diagnostics (visible in the offscreen document's console: chrome://extensions
  // → this extension → "Inspect views: offscreen.html"). Pinpoints a silent 0 KB:
  // empty buffers mean no audio was captured for the M4A.
  console.log('[offscreen] stop: convertM4a=%s liveBytes=%d webmChunks=%d',
    convertM4a, m4aBlob ? m4aBlob.size : 0, chunks.length);

  // Final WebM flush. On failure, commit() routes through fail() or
  // handlePermissionLost() — nothing left to do here.
  if (!await commit({ force: true })) {
    // A permission loss at stop time is terminal: there is no UI left to
    // re-grant (stop is a final action), so fail with a clear message.
    if (permissionLost) {
      await fail('Saving failed: write permission to the output file was lost. Recording stopped. Re-select a save location to start again.');
    }
    return;
  }

  teardownMedia();

  let m4aSaved = false;
  if (convertM4a && m4aSupported) {
    const m4aHandle = await getHandle(M4A_KEY).catch(() => null);
    if (!m4aHandle) {
      // Recording started under the old flow (no .m4a picked at start) — the
      // WebM is saved; there is simply no M4A destination to write to.
      console.log('[offscreen] stop: no M4A save location — skipping the M4A copy');
    } else {
      try {
        sendStatus('converting');
        await saveM4a(m4aHandle, m4aBlob, webmBlob);
        m4aSaved = true;
      } catch (e) {
        // M4A failure is non-fatal: WebM is intact, just log the error
        console.error('[offscreen] M4A save failed:', e?.message || e);
        sendEvt({ m4aDisabled: true, reason: e?.message || String(e) });
      }
    }
  }

  sendStatus('idle', '', { m4a: m4aSaved }); // background persists state + closes this document
}

// ── M4A export (automatic, on every end of recording) ───────────────────────
// Write the M4A copy to the .m4a created at start (same base name as the WebM).
//   Primary path: the live audio/mp4 MediaRecorder already encoded the file —
//     just write its buffered bytes (same proven mechanism as the WebM).
//   Fallback path (older Chrome without audio/mp4 recording): decode the WebM
//     back to PCM and re-encode to AAC with WebCodecs (see m4a.js).

async function saveM4a(m4aHandle, m4aBlob, webmBlob) {
  if (m4aHandle.queryPermission) {
    const perm = await m4aHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('write permission lost for M4A file');
  }

  let outBlob = (m4aBlob && m4aBlob.size) ? m4aBlob : null;
  console.log('[offscreen] saveM4a: liveBytes=%d → %s', m4aBlob ? m4aBlob.size : 0,
    outBlob ? 'writing live M4A' : 'falling back to WebM decode');

  if (!outBlob) {
    // Fallback: no live M4A was captured (audio/mp4 MediaRecorder unsupported).
    if (!webmBlob || !webmBlob.size) throw new Error('no audio was captured');
    // Pin the decode context to a clean, widely supported rate. decodeAudioData
    // resamples to the context's sampleRate, and a default AudioContext adopts the
    // hardware rate (often 96k/192k on Windows). Tab audio is native 48k Opus.
    const ctx = new AudioContext({ sampleRate: AAC_SAMPLE_RATE });
    let audioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(await webmBlob.arrayBuffer());
    } finally {
      tryCall(() => ctx.close());
    }
    const mp4Buffer = await encodeM4a(audioBuffer);
    outBlob = new Blob([mp4Buffer], { type: 'audio/mp4' });
  }

  if (!outBlob.size) throw new Error('produced an empty file');

  console.log('[offscreen] saveM4a: writing %d bytes to the chosen .m4a', outBlob.size);
  const writable = await m4aHandle.createWritable({ keepExistingData: false });
  await writable.write(outBlob);
  await writable.close(); // durability point, same as the WebM commit
}

async function fail(message, { salvage = true } = {}) {
  console.error('[offscreen]', message);
  clearInterval(commitTimer); commitTimer = null;
  clearInterval(tickTimer);   tickTimer = null;
  // An error must not cost the user the M4A: write whatever the live audio/mp4
  // recorder buffered so far to the .m4a chosen at start. This covers e.g. the
  // WebM commit losing write permission after a long pause. Callers that
  // already attempted the M4A write pass salvage:false to avoid a blind retry.
  let salvaged = false;
  if (salvage) {
    try { salvaged = await salvageM4a(); }
    catch (e) { console.warn('[offscreen] M4A salvage failed:', e?.message || e); }
  }
  teardownMedia();
  if (salvaged) message += ' An M4A copy of the audio captured so far was saved.';
  sendStatus('error', message); // background persists + closes this document
}

// Best-effort: flush the live M4A recorder and write its buffer to the .m4a.
// Used only on the error path — the normal path goes through stop()/saveM4a().
async function salvageM4a() {
  if (m4aRecorder && m4aRecorder.state !== 'inactive') {
    await new Promise((resolve) => {
      m4aRecorder.addEventListener('stop', resolve, { once: true });
      try { m4aRecorder.stop(); } catch { resolve(); }
    });
  }
  if (!m4aChunks.length) return false;
  const m4aHandle = await getHandle(M4A_KEY);
  if (!m4aHandle) return false;
  if (m4aHandle.queryPermission &&
      (await m4aHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    return false; // same permission loss as the WebM — nothing we can do headless
  }
  const blob = new Blob(m4aChunks, { type: 'audio/mp4' });
  console.log('[offscreen] salvageM4a: writing %d bytes after error', blob.size);
  const writable = await m4aHandle.createWritable({ keepExistingData: false });
  await writable.write(blob);
  await writable.close();
  return true;
}

// ── Pause / resume (manual + auto) ───────────────────────────────────────────

function manualPause() {
  if (!recorder || manuallyPaused) return;
  manuallyPaused = true;
  if (recorder.state === 'recording') { tryCall(() => recorder.pause()); beginPause(); }
  autoPaused = false;
  // Flush current state (no more data will arrive) then stop timer to avoid
  // repeated createWritable calls during long/idle pause, which can lose
  // the permission grant requiring user activation later.
  commit({ force: true }).finally(() => {
    clearInterval(commitTimer); commitTimer = null;
  });
  sendStatus('paused');
}

function manualResume() {
  if (!recorder) return;
  manuallyPaused = false;
  if (recorder.state === 'paused') { tryCall(() => recorder.resume()); endPause(); }
  // Restart periodic commits now that we are recording again.
  if (!commitTimer) commitTimer = setInterval(commit, COMMIT_INTERVAL);
  sendStatus('recording');
}

function doAutoPause() {
  autoPaused = true;
  if (recorder.state === 'recording') { tryCall(() => recorder.pause()); beginPause(); }
  // Flush then halt commits during the pause (same reason as manual).
  commit({ force: true }).finally(() => {
    clearInterval(commitTimer); commitTimer = null;
  });
  sendStatus('paused');
}

function doAutoResume() {
  autoPaused = false;
  if (recorder.state === 'paused') { tryCall(() => recorder.resume()); endPause(); }
  if (!commitTimer) commitTimer = setInterval(commit, COMMIT_INTERVAL);
  sendStatus('recording');
}

// ── Mute (local playback only — recording is unaffected) ─────────────────────

function setMute(value) {
  if (value === muted) return;
  muted = value;
  if (!source || !audioCtx) return; // applied at start() when capture begins
  // disconnect(destination) only severs the playback path; the analyser tap and
  // the MediaRecorder both keep receiving audio.
  if (muted) tryCall(() => source.disconnect(audioCtx.destination));
  else       tryCall(() => source.connect(audioCtx.destination));
}

function beginPause() { pauseStartedAt = Date.now(); }
function endPause()   { if (pauseStartedAt) { pausedAccumMs += Date.now() - pauseStartedAt; pauseStartedAt = 0; } }

// ── Per-tick work: waveform + timer ─────────────────────────────────────────

function tick() {
  if (!analyser) return;
  analyser.getByteFrequencyData(freqData);
  sendLive(computeBands(freqData), elapsedMs());
}

function elapsedMs() {
  const now = Date.now();
  let paused = pausedAccumMs;
  if ((manuallyPaused || autoPaused) && pauseStartedAt) paused += now - pauseStartedAt;
  return Math.max(0, now - startedAt - paused);
}

function computeBands(freq) {
  const bins = freq.length;
  const step = Math.max(1, Math.floor((bins - 1) / BANDS));
  const out  = new Array(BANDS).fill(0);
  for (let i = 0; i < BANDS; i++) {
    const startBin = 1 + i * step;          // skip DC bin 0
    const endBin   = Math.min(bins, startBin + step);
    let sum = 0, n = 0;
    for (let b = startBin; b < endBin; b++) { sum += freq[b]; n++; }
    out[i] = n ? sum / (n * 255) : 0;
  }
  return out;
}

// ── Disk commit (crash-safe via close()) ─────────────────────────────────────

// Returns true when there was nothing to do or the write landed; false when the
// write failed (fail() has then already salvaged the M4A and reported the error).
async function commit({ force = false } = {}) {
  if (!fileHandle || chunks.length === 0) return true;
  if (committing && !force) return true;
  committing = true;
  try {
    // Pre-check permission. If not granted, do not call createWritable —
    // it would throw "User activation is required..." inside the browser
    // when it tries (and fails) to prompt. Fail with a clean message instead.
    if (fileHandle.queryPermission) {
      const perm = await fileHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        throw new Error('write permission lost (user activation required to re-grant)');
      }
    }
    const blob     = new Blob(chunks, { type: 'audio/webm' });
    const writable = await fileHandle.createWritable({ keepExistingData: false });
    await writable.write(blob);
    await writable.close(); // commit point — data is now durable on disk
  } catch (e) {
    committing = false;
    const msg = e?.message || String(e);
    // Permission loss is not fatal: the grant is tied to the UI window that
    // requested it, so closing that window mid-recording revokes it. Keep the
    // recording alive in memory and wait for the UI to re-grant (see
    // handlePermissionLost / recheckPermission).
    if (/user activation|permission lost|write permission/i.test(msg)) {
      await handlePermissionLost();
    } else {
      await fail('Saving failed: ' + msg);
    }
    return false;
  }
  committing = false;
  return true;
}

// ── Permission loss (UI window closed mid-recording) ─────────────────────────

// The write grant is tied to the UI document that requested it (popup /
// pop-out window). If that window closes mid-recording, the grant dies with it
// and this offscreen engine cannot re-grant headless (no user gesture). Instead
// of failing the recording, keep it alive in memory and wait for the UI to
// re-grant (user gesture) and send 'recheckPermission'.
// ponytail: chunks accumulate in RAM while waiting (~1 MB/min at 128 kbps);
// acceptable for typical sessions, revisit if multi-hour headless recordings matter.
async function handlePermissionLost() {
  if (permissionLost) return;
  permissionLost = true;
  clearInterval(commitTimer); commitTimer = null;
  console.warn('[offscreen] write permission lost — recording continues in memory until the UI re-grants access');
  sendStatus((manuallyPaused || autoPaused) ? 'paused' : 'recording');
}

async function recheckPermission() {
  if (!fileHandle || !fileHandle.queryPermission) return;
  const perm = await fileHandle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return; // still waiting for the user to re-grant
  permissionLost = false;
  const paused = manuallyPaused || autoPaused;
  sendStatus(paused ? 'paused' : 'recording');
  if (!paused && !commitTimer) commitTimer = setInterval(commit, COMMIT_INTERVAL);
  await commit({ force: true });
}

// ── Teardown ─────────────────────────────────────────────────────────────────

function teardownMedia() {
  tryCall(() => { if (m4aRecorder && m4aRecorder.state !== 'inactive') m4aRecorder.stop(); });
  tryCall(() => rawStream?.getTracks().forEach(t => t.stop()));
  tryCall(() => audioCtx?.close());
  rawStream = audioCtx = source = analyser = recorder = m4aRecorder = null;
  fileHandle = null;
  chunks = [];
  m4aChunks = [];
  freqData = null;
  manuallyPaused = autoPaused = false;
  muted = false;
  pausedAccumMs = 0; pauseStartedAt = 0;
  active = false;
  permissionLost = false;
}

function tryCall(fn) { try { fn(); } catch { /* ignore teardown errors */ } }
