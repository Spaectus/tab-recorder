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
const M4A_MIME        = 'audio/mp4;codecs=mp4a.40.2'; // AAC-LC in MP4, for the optional M4A copy

let audioCtx = null, rawStream = null, source = null, analyser = null, recorder = null;
let m4aRecorder = null;  // second recorder, encodes the optional M4A copy live
let m4aChunks = [];       // buffered audio/mp4 chunks (written on Stop & Save)
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

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.action) return; // UI uses .cmd, background events use .evt
  switch (msg.action) {
    case 'startRecordingOffscreen':
      if (!active) { active = true; muted = !!msg.muted; start(msg.streamId); }
      break;
    case 'stopRecordingOffscreen':   stop(msg.m4a);    break;
    case 'pauseRecordingOffscreen':  manualPause();    break;
    case 'resumeRecordingOffscreen': manualResume();   break;
    case 'autoPause':   if (!manuallyPaused && !autoPaused) doAutoPause(); break;
    case 'autoResume':  if (autoPaused) doAutoResume();                    break;
    case 'setMute':     setMute(!!msg.muted);                              break;
  }
});

// Tell the service worker we're alive so it can hand us the start message
// without racing this module's listener registration.
sendEvt({ evt: 'ready' });

function sendEvt(payload)            { chrome.runtime.sendMessage(payload).catch(() => {}); }
function sendStatus(status, error)   { sendEvt({ evt: 'status', status, error: error || '' }); }
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

  // Second recorder for the optional M4A copy. It encodes AAC/MP4 live off the
  // same stream — the most reliable route (decode-then-reencode of the WebM was
  // fragile). Whether the user actually wants the copy is decided at Stop & Save;
  // we buffer it regardless and only write it if asked. It runs CONTINUOUSLY and
  // is never paused: MP4 tolerates pause/resume gaps poorly, and a complete valid
  // file matters more than mirroring the WebM's skipped spans for an extra copy.
  m4aRecorder = null;
  if (MediaRecorder.isTypeSupported(M4A_MIME)) {
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

async function stop(convertM4a = false) {
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

  await commit({ force: true }); // final flush (must run before teardown nulls state)

  // Snapshot the recorded audio before teardown clears the buffers. The WebM is
  // already durable on disk; the M4A is an additional copy. Blobs reference the
  // existing chunk data (no copy), so keeping both around briefly is cheap.
  const m4aBlob  = (convertM4a && m4aChunks.length) ? new Blob(m4aChunks, { type: 'audio/mp4' })  : null;
  const webmBlob = (convertM4a && chunks.length)    ? new Blob(chunks,    { type: 'audio/webm' }) : null;

  // Diagnostics (visible in the offscreen document's console: chrome://extensions
  // → this extension → "Inspect views: offscreen.html"). Pinpoints a silent 0 KB:
  // convertM4a=false means the popup never asked for M4A; empty buffers mean no
  // audio was captured for it.
  console.log('[offscreen] stop: convertM4a=%s liveBytes=%d webmChunks=%d',
    convertM4a, m4aBlob ? m4aBlob.size : 0, chunks.length);

  teardownMedia();

  if (convertM4a) {
    try {
      sendStatus('converting');
      await saveM4a(m4aBlob, webmBlob);
    } catch (e) {
      // The WebM is intact; report the M4A failure rather than silently dropping it.
      return fail('M4A save failed: ' + (e?.message || e));
    }
  }

  sendStatus('idle'); // background persists state + closes this document
}

// ── M4A export (optional, on Stop & Save) ────────────────────────────────────
// Write the optional M4A copy to the .m4a the user picked in the popup.
//   Primary path: the live audio/mp4 MediaRecorder already encoded the file —
//     just write its buffered bytes (same proven mechanism as the WebM).
//   Fallback path (older Chrome without audio/mp4 recording): decode the WebM
//     back to PCM and re-encode to AAC with WebCodecs (see m4a.js).

async function saveM4a(m4aBlob, webmBlob) {
  const m4aHandle = await getHandle(M4A_KEY);
  if (!m4aHandle) throw new Error('no M4A save location');
  if (m4aHandle.queryPermission) {
    const perm = await m4aHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('no permission to write the M4A file');
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

async function fail(message) {
  console.error('[offscreen]', message);
  clearInterval(commitTimer); commitTimer = null;
  clearInterval(tickTimer);   tickTimer = null;
  teardownMedia();
  sendStatus('error', message); // background persists + closes this document
}

// ── Pause / resume (manual + auto) ───────────────────────────────────────────

function manualPause() {
  if (!recorder || manuallyPaused) return;
  manuallyPaused = true;
  if (recorder.state === 'recording') { tryCall(() => recorder.pause()); beginPause(); }
  autoPaused = false;
  sendStatus('paused');
}

function manualResume() {
  if (!recorder) return;
  manuallyPaused = false;
  if (recorder.state === 'paused') { tryCall(() => recorder.resume()); endPause(); }
  sendStatus('recording');
}

function doAutoPause() {
  autoPaused = true;
  if (recorder.state === 'recording') { tryCall(() => recorder.pause()); beginPause(); }
  sendStatus('paused');
}

function doAutoResume() {
  autoPaused = false;
  if (recorder.state === 'paused') { tryCall(() => recorder.resume()); endPause(); }
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

async function commit({ force = false } = {}) {
  if (!fileHandle || chunks.length === 0) return;
  if (committing && !force) return;
  committing = true;
  try {
    const blob     = new Blob(chunks, { type: 'audio/webm' });
    const writable = await fileHandle.createWritable({ keepExistingData: false });
    await writable.write(blob);
    await writable.close(); // commit point — data is now durable on disk
  } catch (e) {
    committing = false;
    return fail('Saving failed: ' + (e?.message || e));
  }
  committing = false;
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
}

function tryCall(fn) { try { fn(); } catch { /* ignore teardown errors */ } }
