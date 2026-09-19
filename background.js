// Service worker: the ONLY context that touches chrome.storage. It routes UI
// commands, owns the offscreen document's lifecycle, and translates messages
// from the offscreen engine into storage writes the UI can read.
//
// Three message vocabularies share chrome.runtime:
//   UI         -> background : { cmd: ... }     (start/stop/pause/resume/setAutoPause/popOut)
//   background -> offscreen  : { action: ... }  (startRecordingOffscreen/...)
//   offscreen  -> background : { evt: ... }     (ready/status/live)
// Each listener handles only its own shape.

const OFFSCREEN_URL = 'offscreen.html';

let pendingStart = null; // { streamId, autoPause } awaiting the offscreen doc

chrome.runtime.onInstalled.addListener(initState);
chrome.runtime.onStartup.addListener(initState);

// Storage outlives the offscreen engine: if the SW slept or the extension
// reloaded mid-recording, storage still says 'recording'/'paused' while the
// engine is gone. That stale state makes the UI show "Stop & Save" with nothing
// to stop — the user gets wedged. Reconcile on every startup: an active status
// with no offscreen document is impossible, so reset it to idle.
async function initState() {
  const { status } = await chrome.storage.local.get('status');
  if (!status) {
    await chrome.storage.local.set({ status: 'idle', autoPause: false, muted: false });
  } else if ((status === 'recording' || status === 'paused') && !(await hasOffscreen())) {
    await resetToIdle();
  }
  const { status: now } = await chrome.storage.local.get('status');
  updateBadge(now || 'idle');
}

async function resetToIdle() {
  pendingStart = null;
  await chrome.storage.local.set({ status: 'idle', error: '' });
  await chrome.storage.session.remove(['waveform', 'elapsedMs']);
  updateBadge('idle');
}

// Toolbar badge so recording state is visible without opening the popup.
function updateBadge(status) {
  const styles = {
    recording:  { text: 'REC', color: '#e53e3e', title: 'Recording — click to manage' },
    paused:     { text: 'II',  color: '#dd6b20', title: 'Paused — click to manage' },
    converting: { text: '…',   color: '#3182ce', title: 'Converting to M4A…' },
    error:      { text: '!',   color: '#e53e3e', title: 'Recording error — click for details' }
  };
  const s = styles[status];
  chrome.action.setBadgeText({ text: s ? s.text : '' });
  chrome.action.setTitle({ title: s ? s.title : 'Tab Audio Recorder' });
  if (s) {
    chrome.action.setBadgeBackgroundColor({ color: s.color });
    try { chrome.action.setBadgeTextColor({ color: '#ffffff' }); } catch { /* older Chrome */ }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.cmd) { return handleCmd(msg); } // return promise for async response
  if (msg?.evt) { handleEvt(msg); return false; }
  return false;
});

// ── UI commands ──────────────────────────────────────────────────────────────

async function handleCmd(msg) {
  try {
    switch (msg.cmd) {
      case 'start':        await startRecording(msg.tabId, msg.tabTitle); break;
      case 'stop':
        // If the engine is gone (stale state), there's nothing to forward to —
        // reset directly so the user isn't stuck on a dead "Stop & Save".
        // M4A defaults to on: the destination was created at start.
        if (await hasOffscreen()) await forward('stopRecordingOffscreen', { m4a: msg.m4a !== false });
        else await resetToIdle();
        break;
      case 'pause':        await forward('pauseRecordingOffscreen');      break;
      case 'resume':       await forward('resumeRecordingOffscreen');     break;
      case 'setAutoPause': {
        const enabled = !!msg.enabled;
        await chrome.storage.local.set({ autoPause: enabled });
        if (enabled) await applyAudibleNow();   // pause immediately if the tab is already silent
        else await forward('autoResume');        // turning auto-pause off lifts any auto-pause
        break;
      }
      case 'setMute': {
        const muted = !!msg.muted;
        await chrome.storage.local.set({ muted });
        await forward('setMute', { muted });
        break;
      }
      case 'popOut':       await openPopout(); break;
      default: return { ok: false, error: 'unknown cmd' };
    }
    return { ok: true };
  } catch (e) {
    await setError(e?.message || String(e));
    return { ok: false, error: e?.message || String(e) };
  }
}

async function startRecording(tabId, tabTitle) {
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    throw new Error('Could not capture this tab: ' + (e?.message || e));
  }
  const { autoPause, muted } = await chrome.storage.local.get(['autoPause', 'muted']);
  pendingStart = { streamId, autoPause: !!autoPause, muted: !!muted };
  await chrome.storage.local.set({
    status: 'recording',
    recordingTabId: tabId,
    tabTitle: tabTitle || '',
    error: '',
    startedAt: Date.now()
  });
  updateBadge('recording');
  // A fresh offscreen doc announces itself with { evt:'ready' }, which triggers
  // the start. An already-open doc won't, so poke it directly in that case.
  const created = await ensureOffscreen();
  if (!created) sendStartToOffscreen();
}

function sendStartToOffscreen() {
  if (!pendingStart) return;
  chrome.runtime.sendMessage({ action: 'startRecordingOffscreen', ...pendingStart });
}

// ── Events from the offscreen engine ────────────────────────────────────────

async function handleEvt(msg) {
  switch (msg.evt) {
    case 'ready':
      sendStartToOffscreen();
      break;
    case 'status':
      await chrome.storage.local.set({ status: msg.status, error: msg.error || '' });
      updateBadge(msg.status);
      if (msg.status === 'error') {
        await showNotification('tab-recorder-error', msg.error, 2);
      } else if (msg.status === 'idle') {
        await showSavedNotification(msg);
      }
      if (msg.status === 'idle' || msg.status === 'error') {
        pendingStart = null;
        await chrome.storage.session.remove(['waveform', 'elapsedMs']);
        await closeOffscreen();
      }
      break;
    case 'live':
      await chrome.storage.session.set({ waveform: msg.waveform, elapsedMs: msg.elapsedMs });
      break;
  }
}

// ── Offscreen lifecycle ──────────────────────────────────────────────────────

async function forward(action, extra = {}) {
  if (await hasOffscreen()) chrome.runtime.sendMessage({ action, ...extra });
}

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return false;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio for recording'
  });
  return true;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch { /* already gone */ }
  }
}

async function setError(message) {
  await chrome.storage.local.set({ status: 'error', error: message });
  updateBadge('error');
  await showNotification('tab-recorder-error', message, 2);
}

async function showSavedNotification(msg) {
  const { tabTitle } = await chrome.storage.local.get('tabTitle');
  let text = 'Recording saved';
  if (tabTitle) text += ` — ${tabTitle}`;
  if (msg.m4a) text += ' (WebM + M4A)';
  await showNotification('tab-recorder-saved', text);
}

async function showNotification(id, message, priority = 1) {
  if (!message) return;
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: 'Tab Audio Recorder',
      message: String(message).slice(0, 240),
      priority
    });
  } catch { /* notifications unavailable or permission denied */ }
}

// If the tab being recorded is closed, finalize & save what we have.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { recordingTabId, status } = await chrome.storage.local.get(['recordingTabId', 'status']);
  if (tabId === recordingTabId && (status === 'recording' || status === 'paused')) {
    await forward('stopRecordingOffscreen');
  }
});

// Auto-pause follows the tab's audio indicator (tab.audible = the speaker icon).
// When the recorded tab stops producing sound, pause; when it resumes, resume.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!('audible' in changeInfo)) return;
  const { recordingTabId, status, autoPause } =
    await chrome.storage.local.get(['recordingTabId', 'status', 'autoPause']);
  if (tabId !== recordingTabId || !autoPause) return;
  if (status !== 'recording' && status !== 'paused') return;
  // tab.audible tracks the source tab's own playback, not our local monitoring,
  // so this stays correct whether or not "Mute playback" is on.
  await forward(changeInfo.audible ? 'autoResume' : 'autoPause');
});

// When auto-pause is switched on mid-recording, pause right away if the tab is
// already silent (no upcoming 'audible' change would otherwise trigger it).
async function applyAudibleNow() {
  const { recordingTabId, status } = await chrome.storage.local.get(['recordingTabId', 'status']);
  if (status !== 'recording' && status !== 'paused') return;
  try {
    const tab = await chrome.tabs.get(recordingTabId);
    if (tab && tab.audible === false) await forward('autoPause');
  } catch { /* tab gone */ }
}

// ── Pop-out window (persistent, detachable view) ─────────────────────────────

async function openPopout() {
  const targetUrl = chrome.runtime.getURL('ui.html?mode=window');
  const basePath  = targetUrl.split('?')[0];
  const { popoutWindowId } = await chrome.storage.local.get('popoutWindowId');

  // Only reuse the stored window if it still exists AND is actually our recorder
  // UI. Window IDs get reused, so a stale ID may now point at an unrelated window
  // (e.g. the user's homepage) — focusing that is the bug we're avoiding here.
  if (popoutWindowId != null) {
    try {
      const win = await chrome.windows.get(popoutWindowId, { populate: true });
      const isOurs = win?.tabs?.some(t => t.url && t.url.startsWith(basePath));
      if (isOurs) { await chrome.windows.update(popoutWindowId, { focused: true }); return; }
    } catch { /* window gone */ }
    await chrome.storage.local.set({ popoutWindowId: null });
  }

  const win = await chrome.windows.create({
    url: targetUrl,
    type: 'popup',
    width: 300,
    height: 400,
    focused: true
  });
  await chrome.storage.local.set({ popoutWindowId: win.id });
}

chrome.windows.onRemoved.addListener(async (winId) => {
  const { popoutWindowId } = await chrome.storage.local.get('popoutWindowId');
  if (winId === popoutWindowId) await chrome.storage.local.set({ popoutWindowId: null });
});
