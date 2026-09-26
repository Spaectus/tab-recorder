// Shared controller/viewer for both the toolbar popup (default) and the
// detachable pop-out window (?mode=window). It never assumes recording state —
// it renders whatever the engine reports in chrome.storage.local, and polls
// chrome.storage.session for the live waveform/timer.

import { storeHandle, getHandle, M4A_KEY, DIR_KEY } from './idb.js';
import { isM4aSupported } from './m4a.js';

const isWindow = new URLSearchParams(location.search).get('mode') === 'window';

const $ = (id) => document.getElementById(id);
const recordBtn    = $('recordBtn');
const nameInput    = $('nameInput');
const pauseBtn     = $('pauseBtn');
const autoPauseBtn = $('autoPauseBtn');
const muteBtn      = $('muteBtn');
const popoutBtn    = $('popoutBtn');
const dot          = $('dot');
const statusText   = $('statusText');
const recInfo      = $('recInfo');
const errorEl      = $('error');
const permLostEl   = $('permLost');
const keepOpenNotice = $('keepOpenNotice');
const reconnectBtn = $('reconnectBtn');
const waveform     = $('waveform');
const m4aNotice    = $('m4aNotice');

const bars = Array.from({ length: 10 }, () => {
  const b = document.createElement('div');
  b.className = 'wave-bar';
  waveform.appendChild(b);
  return b;
});

// Always hide pop-out button since we only use pop-out mode now
popoutBtn.style.display = 'none';
document.body.classList.add('window-mode');

// Version comes from the manifest — single source of truth, no hardcoding here.
$('version').textContent = 'v' + chrome.runtime.getManifest().version;

let status = 'idle';
let autoPauseEnabled = false;
let muteEnabled = false;
let tabTitle = '';
let pollId = null;

init();

async function init() {
  const s = await chrome.storage.local.get(['status', 'tabTitle', 'autoPause', 'muted', 'error', 'm4aSupported', 'permissionLost']);
  render(s);
  m4aNotice.style.display = (s.m4aSupported === false) ? 'block' : 'none';

  // Stay in sync with the engine and the other view.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.status || changes.error || changes.tabTitle || changes.autoPause || changes.muted || changes.permissionLost) {
      chrome.storage.local.get(['status', 'tabTitle', 'autoPause', 'muted', 'error', 'permissionLost']).then(render);
    }
    if (changes.m4aSupported) {
      m4aNotice.style.display = (changes.m4aSupported.newValue === false) ? 'block' : 'none';
    }
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render(s = {}) {
  status            = s.status || 'idle';
  autoPauseEnabled  = !!s.autoPause;
  muteEnabled       = !!s.muted;
  if (s.tabTitle != null) tabTitle = s.tabTitle;

  const active     = status === 'recording' || status === 'paused';
  const paused     = status === 'paused';
  const converting = status === 'converting';

  errorEl.style.display = (status === 'error' && s.error) ? 'block' : 'none';
  if (status === 'error' && s.error) errorEl.textContent = s.error;

  // The write grant is tied to the UI window that requested it; if that window
  // closed mid-recording, the engine keeps recording in memory but cannot write
  // to disk until the user re-grants access here.
  permLostEl.style.display = (active && s.permissionLost) ? 'block' : 'none';

  // Crash-safe flushing needs the granting window to stay open — warn up front.
  keepOpenNotice.style.display = active ? 'block' : 'none';

  recordBtn.textContent = active ? 'Stop & Save' : (converting ? 'Converting…' : 'Start Recording');
  recordBtn.classList.toggle('recording', active);
  recordBtn.disabled = converting; // block starting a new recording mid-encode

  // The name is chosen before starting; hide the field while a session is live.
  nameInput.style.display = (active || converting) ? 'none' : 'block';

  pauseBtn.style.display     = active ? 'block' : 'none';
  autoPauseBtn.style.display = active ? 'block' : 'none';
  muteBtn.style.display      = active ? 'block' : 'none';
  pauseBtn.textContent       = paused ? 'Resume' : 'Pause';

  autoPauseBtn.textContent = 'Auto-pause: ' + (autoPauseEnabled ? 'On' : 'Off');
  autoPauseBtn.classList.toggle('active', autoPauseEnabled);

  muteBtn.textContent = 'Mute playback: ' + (muteEnabled ? 'On' : 'Off');
  muteBtn.classList.toggle('active', muteEnabled);

  if (status === 'recording')       { dot.className = 'dot pulse';  statusText.textContent = 'Recording…'; }
  else if (status === 'paused')     { dot.className = 'dot paused'; statusText.textContent = 'Paused'; }
  else if (status === 'converting') { dot.className = 'dot paused'; statusText.textContent = 'Converting to M4A…'; }
  else if (status === 'error')      { dot.className = 'dot error';  statusText.textContent = 'Error'; }
  else                              { dot.className = 'dot';        statusText.textContent = 'Ready'; }

  if (active) {
    waveform.classList.add('active');
    waveform.classList.toggle('paused', paused);
    recInfo.style.display = 'block';
    startPoll();
  } else {
    waveform.classList.remove('active', 'paused');
    bars.forEach(b => { b.style.height = '2px'; });
    recInfo.style.display = 'none';
    recInfo.textContent = '';
    stopPoll();
  }
}

function startPoll() {
  if (pollId) return;
  pollId = setInterval(async () => {
    const s = await chrome.storage.session.get(['waveform', 'elapsedMs']);
    if (s.waveform) {
      s.waveform.forEach((v, i) => {
        if (bars[i]) bars[i].style.height = Math.max(2, Math.round((v || 0) * 26)) + 'px';
      });
    }
    const head = tabTitle ? `Recording: ${tabTitle}` : 'Recording';
    recInfo.textContent = `${head}  ·  ${fmtTime(s.elapsedMs || 0)}`;
  }, 100);
}

function stopPoll() { clearInterval(pollId); pollId = null; }

// ── Commands ─────────────────────────────────────────────────────────────────

recordBtn.addEventListener('click', async () => {
  if (status === 'recording' || status === 'paused') {
    // The M4A destination was already created at start (same base name as the
    // WebM), so stopping never asks anything — the engine writes both files.
    recordBtn.disabled = true;
    // Ensure we still hold write permission for the final commit (gesture present).
    await ensureWritePermission();
    await send('stop', { m4a: true });
    return;
  }

  // The name is set before recording; the folder is picked here. M4A support is
  // detected first so the .m4a destination is created alongside the .webm only
  // when this browser can actually fill it — no empty .m4a otherwise.
  const base = sanitizeName(nameInput.value) || `recording_${fileStamp()}`;

  const tab = await getTargetTab();
  if (!tab) return showError('Could not find a tab to record. Focus the tab first.');

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ id: 'tab-recorder', mode: 'readwrite' });
  } catch {
    return; // user cancelled the picker
  }

  const m4aSupported = await isM4aSupported();
  let webmHandle, m4aHandle;
  try {
    webmHandle = await dirHandle.getFileHandle(`${base}.webm`, { create: true });
    if (m4aSupported) m4aHandle = await dirHandle.getFileHandle(`${base}.m4a`, { create: true });
  } catch (e) {
    return showError('Could not create the output files: ' + (e?.message || e));
  }

  await storeHandle(dirHandle, DIR_KEY);
  await storeHandle(webmHandle);
  if (m4aHandle) await storeHandle(m4aHandle, M4A_KEY);

  chrome.runtime.sendMessage({ cmd: 'start', tabId: tab.id, tabTitle: tab.title || '' });
});

pauseBtn.addEventListener('click', async () => {
  if (status === 'paused') {
    // This click is a user gesture — use it to re-request write permission for
    // the long-lived file handle. Long pauses can cause the permission grant
    // to require activation again before createWritable succeeds in offscreen.
    await ensureWritePermission();
  }
  send(status === 'paused' ? 'resume' : 'pause');
});
autoPauseBtn.addEventListener('click', () => send('setAutoPause', { enabled: !autoPauseEnabled }));
muteBtn.addEventListener('click', () => send('setMute', { muted: !muteEnabled }));

// Re-grant write access after the granting window was closed mid-recording.
// This click is the user gesture requestPermission() needs; the engine then
// resumes committing to disk.
reconnectBtn.addEventListener('click', async () => {
  await ensureWritePermission();
  await send('recheckPermission');
});

// Pop-out window: get the active tab from the last focused normal browser window
async function getTargetTab() {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
  return win?.tabs?.find(t => t.active);
}

function send(cmd, extra = {}) {
  return chrome.runtime.sendMessage({ cmd, ...extra }).catch(() => {});
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.style.display = 'block';
}

// Load the stored directory handle (or the legacy file handle) and use the
// current click's transient activation to call requestPermission(). This keeps
// the permission 'granted' so that the offscreen document's background
// createWritable calls (every ~10s) do not hit the "User activation is
// required" error after long idle/pauses. Re-granting the DIRECTORY covers
// both the .webm and the .m4a in one prompt.
async function ensureWritePermission() {
  try {
    const handle = (await getHandle(DIR_KEY)) || (await getHandle());
    if (!handle || !handle.queryPermission) return;
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && handle.requestPermission) {
      perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        showError('Write permission was not granted. The file may not save correctly.');
      }
    }
  } catch {
    // Non-fatal: the next write will surface a clear error if it fails.
  }
}

function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function fileStamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

// Make the typed name safe as a file basename: strip an extension the user may
// have typed, characters Windows/macOS forbid, and trailing dots/spaces.
function sanitizeName(raw) {
  return (raw || '')
    .replace(/\.(webm|m4a)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
}
