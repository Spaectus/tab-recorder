# Tab Audio Recorder — Chrome Extension (v2)

## What It Does

A Chrome Manifest V3 extension that records the audio output of a chosen browser tab and
saves it as a **WebM/Opus** file to a user-picked location on disk. Recording is **crash-safe**:
the file is committed to disk every ~10 seconds, so a crash loses at most a few seconds of audio.

The recording is **locked to the tab you start on** — switching tabs or opening new ones never
changes what is captured. A small **detachable window** can be popped out so the status, waveform,
and timer stay visible while you work in other tabs.

---

## Why a rewrite (v1 → v2)

v1 produced empty/corrupt files. Root causes were architectural:

| v1 problem | v2 fix |
|---|---|
| `ScriptProcessorNode` + `lamejs` encoding **on the audio thread** (deprecated, glitchy) | **MediaRecorder** with `audio/webm;codecs=opus` — encoding happens off-thread |
| Stored **views** into lamejs's reused buffer → corrupt MP3 | MediaRecorder yields independent `Blob` chunks (no aliasing) |
| Write errors swallowed; popup still showed "Recording…" | Failures surface as a visible **error state** in the UI |
| Popup flipped to "Recording" optimistically | UI renders **only** what the engine reports in storage |
| File-handle write permission never verified across contexts | Permission is verified/requested in the UI under the user's click gesture |

WebM/Opus plays in all modern players and browsers. An optional **M4A (AAC)** copy is offered on
Stop & Save for players that prefer the more universal MPEG-4 container.

---

## File Structure

```
tab-recorder/
  manifest.json   — MV3 manifest (permissions: tabCapture, offscreen, storage, tabs)
  background.js   — service worker: command router, offscreen lifecycle, tab-close watch, pop-out window
  offscreen.html  — offscreen document shell (loads offscreen.js as a module)
  offscreen.js    — recording engine: WebM MediaRecorder + AnalyserNode + disk commit + auto-pause
                    + a second audio/mp4 MediaRecorder for the optional M4A copy
  m4a.js          — M4A (AAC) encoder FALLBACK for older Chrome: WebCodecs AudioEncoder + mp4-muxer
  mp4-muxer.mjs   — vendored MP4/M4A muxer (mp4-muxer 5.2.2), used by the fallback only
  ui.html         — shared UI for the toolbar popup and the pop-out window
  ui.js           — shared controller/viewer logic
  ui.css          — dark-theme styles
  idb.js          — tiny IndexedDB store for the FileSystemFileHandle(s)
  test/           — Chrome end-to-end tests for the M4A export (run on real Google Chrome)
```

### Optional M4A export (on Stop & Save)

When you press **Stop & Save**, you're asked whether to also save an **M4A** (AAC) copy. The WebM is
always written; M4A is an extra copy:

1. **During recording**, alongside the WebM recorder, a **second `MediaRecorder` encodes the same
   stream directly to `audio/mp4;codecs=mp4a.40.2` (AAC-LC, 128 kbps)** and buffers the chunks. This
   is the identical, proven mechanism the WebM uses — no decode/re-encode. The M4A recorder runs
   **continuously** (it is never paused: MP4 tolerates pause/resume gaps poorly, and a valid complete
   file matters more than mirroring the WebM's skipped spans for an extra copy).
2. On **Stop & Save**, the popup asks whether to keep the M4A and, if so, opens a second save picker
   for the `.m4a` (under the click's user gesture, as `showSaveFilePicker` requires). The handle is
   stashed in IndexedDB under a separate key.
3. The offscreen engine finishes the WebM commit, then writes the buffered `audio/mp4` blob to the
   chosen file — same `createWritable → write → close` durability point as the WebM.
4. If the M4A step fails, the WebM is still intact and the failure surfaces as an error.

> **Fallback:** on Chrome versions that can't record `audio/mp4` directly, the engine instead decodes
> the recorded Opus to PCM and re-encodes it to AAC with the browser's native **WebCodecs
> `AudioEncoder`** + the bundled **mp4-muxer** ([m4a.js](m4a.js)).
>
> This replaced an earlier lamejs MP3 export, which ran on the main thread, supported only a few
> sample rates, and silently mislabeled others — producing 0 KB / corrupt files. Both M4A paths are
> verified by `test/m4a-conversion.test.mjs` (run on real Google Chrome, which has the AAC codec).

---

## Architecture

The **offscreen document is the recording engine** (stream, MediaRecorder, file handle, disk
commits). The popup and the pop-out window are **pure controllers/viewers** — closing them never
stops the recording. The **service worker is the only context that touches `chrome.storage`**,
because **offscreen documents have no `chrome.storage`** (only `chrome.runtime` + IndexedDB). All
offscreen state therefore flows to the SW as messages, and the SW writes storage for the UI to read.

```
[ ui.html (popup) | ui.html?mode=window (pop-out) ]   ← ui.js / ui.css
        │  { cmd } start|stop|pause|resume|setAutoPause|popOut         reads chrome.storage
        ▼                                                                    ▲
   background.js  (service worker — owns chrome.storage + offscreen lifecycle)
        │  { action } startRecordingOffscreen{streamId,autoPause}|...   writes:
        ▼                                                              local{status,recordingTabId,
   offscreen.js  (MediaRecorder + AnalyserNode + commit loop)            tabTitle,autoPause,error}
        │  { evt } ready | status{status,error} | live{waveform,elapsedMs}  session{waveform,elapsedMs}
        └──────────────────────────────────────────────────────────▲
```

Three message vocabularies share `chrome.runtime`: UI uses `{ cmd }`, background→offscreen uses
`{ action }`, offscreen→background uses `{ evt }`. Each listener handles only its own shape.

**Start hand-off & the load race:** a freshly-created offscreen module sends `{ evt:'ready' }`; the
SW replies with `startRecordingOffscreen` carrying the `streamId` in the message (not storage). This
avoids both the missing-`chrome.storage` problem and the race where a message sent right after
`createDocument()` arrives before the module's listener is registered.

### Why an offscreen document?
MV3 service workers cannot use audio APIs. The offscreen document (`USER_MEDIA` reason) is a hidden
page that can call `getUserMedia` / Web Audio / `MediaRecorder`, and persists for the whole session.

### File handle persistence
`showSaveFilePicker()` returns a `FileSystemFileHandle` that can't be sent through messages. The UI
stores it in **IndexedDB** (`idb.js`) after verifying write permission; `offscreen.js` reads it back.

---

## Recording Pipeline (`offscreen.js`)

```
tab stream ─┬─> AudioContext.destination   (keeps the tab audible — tabCapture mutes it otherwise)
            └─> AnalyserNode               (waveform + silence detection)
tab stream ───> MediaRecorder(webm/opus)   (encoding)
```

1. `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } } })`.
2. Web Audio graph for monitoring + analysis (above).
3. `new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 })`,
   `recorder.start(1000)` → a `Blob` chunk every second via `ondataavailable`.
4. **Commit** every 10 s: `Blob(chunks)` → `createWritable({ keepExistingData:false })` → `write` →
   **`close()`**. `close()` is the durability point — a kept-open stream would lose data on crash.
5. **Stop**: `recorder.stop()`, wait for the final chunk, final commit, tear down, close the offscreen doc.

### Waveform + timer
A 100 ms `setInterval` (off the audio thread) reads `AnalyserNode.getByteFrequencyData` → 10 bands
and computes elapsed time (excluding paused spans). It sends both to the SW as `{ evt:'live' }`; the
SW writes `chrome.storage.session`, which the UI polls at 100 ms. (offscreen→SW messaging is
reliable; the SW→storage→UI hop keeps the UI's read path as plain shared state.)

### Auto-pause
Driven by the tab's audio indicator — the **speaker icon**, exposed as `tab.audible`. The service
worker watches `chrome.tabs.onUpdated` for `audible` changes on the recorded tab: `false` →
`recorder.pause()`, `true` → `recorder.resume()` (never overriding a manual pause). Real
pause/resume cleanly omits the silent span from the WebM (safe for WebM, unlike MP4). Chrome's own
`audible` flag has a ~1–2 s debounce before it clears, so pausing matches the icon rather than a
separate hidden timer.

### Mute playback
Independent of recording. The captured tab stream is split: it feeds the `MediaRecorder` (encoding)
and the `AnalyserNode` (waveform) directly, and *separately* connects to `AudioContext.destination`
so you keep hearing the tab. **Mute playback** just severs that destination connection
(`source.disconnect(destination)`); the recorder and waveform are untouched, so the file keeps
capturing the original tab while it goes silent locally. Useful for recording one tab in the
background while you watch videos on other tabs without hearing both at once.

Mute is **independent of auto-pause**. `tab.audible` reflects whether the source tab is *producing*
sound (Chrome: "produced sound over the past couple seconds — might not be heard if muted"), not
whether we monitor it locally. So auto-pause keeps tracking the recorded tab's real playback and
works normally whether or not Mute playback is on.

## Popup / window UI states

| State | Dot | Status | Buttons | Waveform |
|---|---|---|---|---|
| Idle | green | Ready | Start, (Pop out in popup) | hidden |
| Recording | red pulse | Recording… + "Recording: <tab>" + timer | Stop, Pause, Auto-pause, Mute playback | red bars |
| Paused | orange | Paused | Stop, Resume, Auto-pause, Mute playback | orange bars |
| Error | red solid | Error + message | Start | hidden |

UI state is read from `chrome.storage.local` on open and kept in sync via `chrome.storage.onChanged`.

The **toolbar badge** reflects state without opening anything: red **REC** while recording, orange
**II** while paused, red **!** on error, cleared when idle (set in `background.js` `updateBadge`).

---

## Loading & testing

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → this folder.
2. Play audio in a tab → click the extension → **Start Recording** → pick a `.webm` location.
3. Confirm the file grows on disk within ~10 s, the waveform animates, the timer counts, and you
   still hear the tab.
4. Try Pause/Resume, Auto-pause, and **Pop out** (switch tabs — recording continues, window stays).
5. **Stop & Save**, then open the `.webm` in Chrome or VLC to confirm it plays end-to-end.
6. Crash test: kill Chrome mid-recording; the file plays up to the last commit (≤ ~10 s lost).
