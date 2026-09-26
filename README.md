# Tab Audio Recorder

Chrome Manifest V3 extension that records the audio output of a browser tab and saves it as a **WebM/Opus** file to a location you choose. Recording is **crash-safe**: the file is flushed to disk every ~10 seconds, so a crash loses at most a few seconds of audio.

An **M4A (AAC)** copy is saved automatically alongside the WebM — under the same base name, chosen once at start — whenever the recording ends: manual Stop & Save, the recorded tab closing, or even an error mid-recording.

## Features

- **Tab-locked capture** — recording stays on the tab you started from; switching tabs does not change the source
- **Crash-safe writes** — full blob committed to disk every ~10 s via `createWritable → write → close`
- **Detachable window** — pop out the UI to keep status, waveform, and timer visible while working in other tabs
- **Live waveform & timer** — 10-band frequency display and elapsed time (paused time excluded)
- **Auto-pause** — follows the tab's speaker icon (`tab.audible`); pauses when the tab goes silent, resumes when it plays again
- **Mute playback** — silence local monitoring without affecting what gets recorded
- **Automatic M4A export** — live `audio/mp4` encoding during recording, written on every end of recording (with a WebCodecs fallback on older Chrome)
- **Toolbar badge** — `REC` / `II` / `…` / `!` so state is visible without opening the popup

## Requirements

- **Google Chrome** (Manifest V3, `tabCapture`, offscreen documents, File System Access API)
- For automated M4A tests: **Node.js** and **Playwright** (real Chrome channel)

## Installation

1. Clone this repository or download the source.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.

## Usage

1. Play audio in the tab you want to record.
2. Click the extension icon, optionally type a recording name (default: `recording_<timestamp>`), then click **Start Recording**.
3. Pick the folder to save into. Both `<name>.webm` and `<name>.m4a` are created there up front — the `.m4a` only when the browser supports M4A.
4. Confirm the `.webm` grows on disk within ~10 s, the waveform animates, the timer counts, and you still hear the tab.
5. Use **Pause**, **Auto-pause**, or **Mute playback** as needed.
6. Optionally click **Pop out** to keep the UI visible in a separate window.
7. Click **Stop & Save** when finished — both files are finalized automatically, no further prompts.
8. Open the `.webm` and `.m4a` in Chrome, VLC, or another player to verify playback.

### Which tab gets recorded?

| UI context | Target tab |
|---|---|
| Toolbar popup | Active tab of the **current** window |
| Pop-out window (`?mode=window`) | Active tab of the **last focused normal** browser window |

Focus the tab you want before starting. In pop-out mode, the recorder window itself is not the capture target.

### Tab close & crashes

- **Closing the recorded tab** automatically stops recording and saves what has been captured so far.
- **Killing Chrome mid-recording** — the on-disk file plays up to the last commit (≤ ~10 s lost).

## UI states

The popup and pop-out window are pure viewers — they render only what the engine reports in `chrome.storage.local`. Closing the UI does not stop a recording.

**Write permission is tied to the UI window that granted it.** If you close that window mid-recording, the engine keeps recording in memory but can no longer flush to disk (Chrome revokes the grant with the window). Reopen the UI and click **Reconnect save folder** to re-grant access and resume disk writes; **Stop & Save** re-grants automatically.

| State | Dot | Status text | Primary button | Other controls |
|---|---|---|---|---|
| Idle | green | Ready | Start Recording | Pop out (popup only) |
| Recording | red pulse | Recording… | Stop & Save | Pause, Auto-pause, Mute playback |
| Paused | orange | Paused | Stop & Save | Resume, Auto-pause, Mute playback |
| Converting | orange | Converting to M4A… | Converting… (disabled) | hidden |
| Error | red solid | Error + message | Start Recording | hidden |

While recording or paused, a second line shows `Recording: <tab title> · HH:MM:SS`.

### Toolbar badge

| Status | Badge | Color |
|---|---|---|
| Recording | `REC` | red |
| Paused | `II` | orange |
| Converting | `…` | blue |
| Error | `!` | red |
| Idle | *(cleared)* | — |

## Automatic M4A export

The `.m4a` destination is created at **start**, in the same folder and under the same base name as the `.webm` — but only when the browser supports M4A, so no empty `.m4a` appears on browsers that don't. When the recording ends — for any reason — the M4A is written automatically, with no dialog.

1. **During recording**, a second `MediaRecorder` encodes the same stream to `audio/mp4;codecs=mp4a.40.2` (AAC-LC, 128 kbps) and buffers chunks. It runs **continuously** and is never paused — MP4 tolerates pause/resume gaps poorly, and a complete file matters more than mirroring the WebM's skipped spans.
2. The `.m4a` handle is created via the directory picked at start and stored in IndexedDB under a separate key (`m4aFileHandle`).
3. On **Stop & Save** (or tab close), the offscreen engine finalizes the WebM, then writes the buffered `audio/mp4` blob (or runs the fallback) to the `.m4a`.
4. **On an error mid-recording** (e.g. write permission lost after a very long pause), the engine still flushes the M4A recorder and writes whatever was captured so far to the `.m4a` before reporting the error, so the audio is not lost.
5. If the M4A write fails, the WebM remains intact and the error is shown in the UI.

**Fallback path:** when live `audio/mp4` recording is unsupported, the engine decodes the WebM to PCM and re-encodes to AAC via WebCodecs `AudioEncoder` + the bundled [mp4-muxer](mp4-muxer.mjs) ([m4a.js](m4a.js)). A dedicated `converting` status is shown while this runs.

## Architecture

The **offscreen document** is the recording engine (stream, MediaRecorder, file handles, disk commits). The **service worker** is the only context that touches `chrome.storage` — offscreen documents have `chrome.runtime` and IndexedDB only. The popup and pop-out window send commands and read storage; they never own recording state directly.

```
[ ui.html (popup) | ui.html?mode=window (pop-out) ]     ui.js / ui.css
        │  { cmd } start | stop | pause | resume | setAutoPause | setMute | popOut
        │  reads chrome.storage.local + session
        ▼
   background.js  (service worker — storage, offscreen lifecycle, tab-close watch)
        │  { action } startRecordingOffscreen | stopRecordingOffscreen | …
        │  writes local { status, recordingTabId, tabTitle, autoPause, muted, error, startedAt, popoutWindowId }
        │         session { waveform, elapsedMs }
        ▼
   offscreen.js  (MediaRecorder + AnalyserNode + commit loop + optional M4A recorder)
        │  { evt } ready | status | live
        └──────────────────────────────────────────────────────────▲
```

Three message vocabularies share `chrome.runtime`: UI uses `{ cmd }`, background→offscreen uses `{ action }`, offscreen→background uses `{ evt }`.

**Start hand-off:** a new offscreen module sends `{ evt: 'ready' }`; the service worker replies with `startRecordingOffscreen` carrying `streamId`, `autoPause`, and `muted` in the message (not storage). This avoids the race where a message sent immediately after `createDocument()` arrives before the module listener is registered.

**Stale-state recovery:** on install and browser startup, if storage says `recording` or `paused` but no offscreen document exists, the service worker resets to idle. This prevents a wedged "Stop & Save" UI after an extension reload or service-worker sleep.

**File handles:** the UI calls `showDirectoryPicker()` once at start and creates `<name>.webm` and — when the browser supports M4A — `<name>.m4a` in the chosen folder. `FileSystemHandle`s cannot cross extension message boundaries, so the UI stores the directory + both file handles in IndexedDB ([idb.js](idb.js)); the offscreen engine reads them back. A later click (pause/stop) re-requests write permission on the **directory**, covering both files at once.

### Recording pipeline

```
tab stream ─┬─> AudioContext.destination   (keeps the tab audible — tabCapture mutes it otherwise)
            └─> AnalyserNode               (waveform)
tab stream ───> MediaRecorder(webm/opus)   (primary encode, off main thread)
tab stream ───> MediaRecorder(audio/mp4)   (live M4A buffer, when supported)
```

1. `getUserMedia` with `chromeMediaSource: 'tab'`.
2. Web Audio graph for local playback and waveform analysis.
3. `MediaRecorder` at 128 kbps, `start(1000)` — one chunk per second.
4. **Commit** every 10 s: `Blob(chunks)` → `createWritable({ keepExistingData: false })` → `write` → **`close()`**.
5. **Stop:** final chunk, final commit, automatic M4A write, teardown, offscreen document closed.

### Auto-pause

The service worker watches `chrome.tabs.onUpdated` for `audible` on the recorded tab:

- `audible: false` → `autoPause` (never overrides a manual pause)
- `audible: true` → `autoResume`
- **Enabling auto-pause mid-recording** immediately pauses if the tab is already silent
- **Disabling auto-pause** sends `autoResume` to lift an auto-pause

Chrome's `audible` flag debounces ~1–2 s, so pausing tracks the speaker icon rather than a hidden timer. Mute playback is independent — `audible` reflects whether the source tab is producing sound, not whether you hear it locally.

### Mute playback

Disconnects `source` from `AudioContext.destination` only. The `MediaRecorder` and `AnalyserNode` keep receiving audio. The mute preference is persisted in `chrome.storage.local` and applied when a new recording starts.

## Project structure

```
tab-recorder/
├── manifest.json      MV3 manifest (tabCapture, offscreen, storage, tabs) — version source of truth
├── CHANGELOG.md       Version history (popup shows the manifest version)
├── background.js      Service worker: routing, storage, offscreen lifecycle
├── offscreen.html     Offscreen document shell
├── offscreen.js       Recording engine
├── m4a.js             M4A fallback encoder (WebCodecs + mp4-muxer)
├── mp4-muxer.mjs      Vendored MP4/M4A muxer (mp4-muxer 5.2.2)
├── ui.html            Shared UI (popup + pop-out)
├── ui.js              Controller / viewer
├── ui.css             Dark-theme styles
├── idb.js             IndexedDB store for FileSystemFileHandle(s)
└── test/
    ├── extension-m4a.test.mjs   Playwright — both M4A paths
    └── m4a-conversion.test.mjs  CDP — full extension offscreen E2E
```

## Development & testing

### Manual smoke test

1. Load unpacked (see [Installation](#installation)).
2. Record a tab; verify waveform, timer, pause/resume, auto-pause, mute, and pop-out.
3. Stop & Save; confirm both `<name>.webm` and `<name>.m4a` appear in the chosen folder with no extra prompt.
4. Crash test: kill Chrome mid-recording; confirm the file plays up to the last commit.

### Automated M4A tests

Both tests require **Google Chrome** (proprietary AAC codec).

**Primary automated coverage** — exercises both M4A paths in a local Playwright harness:

```bash
node test/extension-m4a.test.mjs
```

Tests the live `audio/mp4` MediaRecorder path and the `encodeM4a()` WebCodecs fallback. Playwright must be importable; set `PLAYWRIGHT_DIR` if it lives outside the project.

**Full extension E2E** — runs the conversion inside the real offscreen document via Chrome DevTools Protocol:

```bash
node test/m4a-conversion.test.mjs
```

May **skip** on Chrome 137+ where `--load-extension` is blocked; use the Playwright test for CI and verify the in-extension path manually via Load unpacked.

## Background: v1 → v2 rewrite

v1 produced empty or corrupt files. v2 replaced the architecture entirely:

| v1 problem | v2 fix |
|---|---|
| `ScriptProcessorNode` + lamejs on the audio thread | `MediaRecorder` with `audio/webm;codecs=opus` |
| Buffer aliasing into lamejs's reused buffer | Independent `Blob` chunks per `ondataavailable` |
| Write errors swallowed; UI still showed "Recording…" | Failures surface as a visible error state |
| Popup flipped to "Recording" optimistically | UI renders only what the engine reports in storage |
| File-handle permission never verified across contexts | Permission verified in the UI under the user's click gesture |

The old lamejs MP3 export was replaced by the current M4A paths (live `audio/mp4` + WebCodecs fallback).
