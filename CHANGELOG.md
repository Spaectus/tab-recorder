# Changelog

All notable changes to this extension are documented here.
The version shown at the bottom of the popup comes from [manifest.json](manifest.json) — bump it there and add an entry here in the same change.

## 2.1.0 — 2026-07-04

### Changed
- **M4A is now saved automatically** on every end of recording — no more "Also save a copy as M4A?" prompt and second save dialog at stop time.
- **Name and destination are chosen once, at start**: type a recording name in the popup (default `recording_<timestamp>`), pick a folder, and both `<name>.webm` and `<name>.m4a` are created there up front.
- Write permission re-grants (on pause/resume/stop clicks) now target the destination **directory**, covering both files with one prompt.

### Added
- **M4A salvage on error**: if the recording dies mid-session (e.g. write permission lost after a very long pause), the audio buffered so far is still written to the `.m4a` before the error is reported.
- Version number displayed at the bottom of the popup, read from the manifest.
- New extension icon — red microphone with a "TAB" wordmark on the dark theme background, in 16/48/128 px (toolbar action icon included).
- This changelog.

### Fixed
- On a failed final commit during Stop & Save, the in-memory audio buffers were torn down before the M4A snapshot was taken, losing the M4A copy. Buffers are now snapshotted first.

## 2.0 — 2025

- Full rewrite of the v1 recorder: `MediaRecorder` (WebM/Opus) with crash-safe ~10 s disk commits, offscreen-document engine, live waveform and timer, auto-pause via `tab.audible`, mute-local-playback, detachable pop-out window, toolbar badge, and optional M4A export (live `audio/mp4` recorder + WebCodecs fallback).

## 1.x

- Initial version (`ScriptProcessorNode` + lamejs MP3 export). Produced empty or corrupt files; replaced entirely by 2.0.
