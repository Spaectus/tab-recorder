// Shared controller/viewer for both the toolbar popup (default) and the
// detachable pop-out window (?mode=window). It never assumes recording state —
// it renders whatever the engine reports in chrome.storage.local, and polls
// chrome.storage.session for the live waveform/timer.

import { storeHandle, M4A_KEY } from './idb.js';

const isWindow = new URLSearchParams(location.search).get('mode') === 'window';

const $ = (id) => document.getElementById(id);
const recordBtn    = $('recordBtn');
const pauseBtn     = $('pauseBtn');
const autoPauseBtn = $('autoPauseBtn');
const muteBtn      = $('muteBtn');
const popoutBtn    = $('popoutBtn');
const dot          = $('dot');
const statusText   = $('statusText');
const recInfo      = $('recInfo');
const errorEl      = $('error');
const waveform     = $('waveform');

const bars = Array.from({ length: 10 }, () => {
  const b = document.createElement('div');
  b.className = 'wave-bar';
  waveform.appendChild(b);
  return b;
});

if (isWindow) {
  popoutBtn.style.display = 'none';
  document.body.classList.add('window-mode');
}

let status = 'idle';
let autoPauseEnabled = false;
let muteEnabled = false;
let tabTitle = '';
let pollId = null;

init();

async function init() {
  const s = await chrome.storage.local.get(['status', 'tabTitle', 'autoPause', 'muted', 'error']);
  render(s);
  // Stay in sync with the engine and the other view.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.status || changes.error || changes.tabTitle || changes.autoPause || changes.muted) {
      chrome.storage.local.get(['status', 'tabTitle', 'autoPause', 'muted', 'error']).then(render);
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

  recordBtn.textContent = active ? 'Stop & Save' : (converting ? 'Converting…' : 'Start Recording');
  recordBtn.classList.toggle('recording', active);
  recordBtn.disabled = converting; // block starting a new recording mid-encode

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
    // Offer an M4A copy. We must pick the .m4a location now, while this click's
    // user gesture is still live (showSaveFilePicker requires it). The WebM is
    // saved regardless; M4A is an extra encode done by the offscreen engine.
    let wantM4a = confirm('Also save a copy as M4A?\n\nThe WebM file is saved either way.');
    if (wantM4a) {
      try {
        const m4aHandle = await window.showSaveFilePicker({
          suggestedName: `recording_${fileStamp()}.m4a`,
          types: [{ description: 'M4A Audio', accept: { 'audio/mp4': ['.m4a'] } }]
        });
        try {
          if (m4aHandle.queryPermission &&
              (await m4aHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
            if (m4aHandle.requestPermission &&
                (await m4aHandle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
              wantM4a = false;
            }
          }
        } catch { /* some Chrome builds lack these on extension pages — proceed */ }
        if (wantM4a) await storeHandle(m4aHandle, M4A_KEY);
      } catch {
        wantM4a = false; // user cancelled the picker — just save the WebM
      }
    }

    recordBtn.disabled = true;
    await send('stop', { m4a: wantM4a });
    return;
  }

  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: `recording_${fileStamp()}.webm`,
      types: [{ description: 'WebM Audio', accept: { 'audio/webm': ['.webm'] } }]
    });
  } catch {
    return; // user cancelled the picker
  }

  // Ensure readwrite permission while we still have the user's click gesture.
  try {
    if (handle.queryPermission &&
        (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if (handle.requestPermission &&
          (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        return showError('Write permission was denied.');
      }
    }
  } catch { /* some Chrome builds lack these on extension pages — proceed */ }

  const tab = await getTargetTab();
  if (!tab) return showError('Could not find a tab to record. Focus the tab first.');

  await storeHandle(handle);
  await send('start', { tabId: tab.id, tabTitle: tab.title || '' });
});

pauseBtn.addEventListener('click', () => send(status === 'paused' ? 'resume' : 'pause'));
autoPauseBtn.addEventListener('click', () => send('setAutoPause', { enabled: !autoPauseEnabled }));
muteBtn.addEventListener('click', () => send('setMute', { muted: !muteEnabled }));
popoutBtn.addEventListener('click', () => send('popOut'));

// In the popup, the active tab of the current window is the target. In the
// pop-out window (its own popup-type window), fall back to the last focused
// normal browser window's active tab.
async function getTargetTab() {
  if (!isWindow) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
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
