// M4A (AAC-LC in an MP4 container) encoder, used for the optional audio copy
// saved on Stop & Save. Pure module: it takes a decoded AudioBuffer and returns
// the bytes of a finished .m4a file. No chrome.* / DOM dependencies, so it can
// run in a plain page for testing as well as in the offscreen document.
//
// Why this replaced the old lamejs MP3 path: lamejs ran on the main thread,
// only supported a handful of sample rates, and silently mislabeled others —
// producing 0-byte / corrupt files. AAC encoding here goes through the browser's
// native WebCodecs AudioEncoder (off the main thread, hardware-backed where
// available) and the frames are muxed into a standard MP4/M4A that every modern
// player accepts.

import { Muxer, ArrayBufferTarget } from './mp4-muxer.mjs';

export const AAC_BITRATE     = 128_000; // bits/s for the AAC encode
export const AAC_SAMPLE_RATE = 48_000;  // decode/encode rate (tab audio is native 48k Opus)
export const M4A_MIME        = 'audio/mp4;codecs=mp4a.40.2'; // AAC-LC in MP4

// Capability check shared by the UI (decides whether to create the .m4a
// destination) and the offscreen engine (decides whether to run the live
// audio/mp4 recorder). Static browser capability — same result everywhere.
export async function isM4aSupported() {
  if (typeof MediaRecorder === 'undefined' || typeof AudioEncoder === 'undefined') return false;
  if (!MediaRecorder.isTypeSupported(M4A_MIME)) return false;
  try {
    const supported = await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2,
    });
    return supported?.supported === true;
  } catch {
    return false;
  }
}

// Encode a decoded AudioBuffer to a complete .m4a file. Resolves to an
// ArrayBuffer holding the MP4 bytes. Throws (loudly) if WebCodecs AAC is
// unavailable or the encoder errors — the caller keeps the WebM either way.
export async function encodeM4a(audioBuffer) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    throw new Error('WebCodecs AudioEncoder is not available in this browser');
  }

  const numberOfChannels = Math.min(2, audioBuffer.numberOfChannels) || 1; // mono or stereo
  const sampleRate       = audioBuffer.sampleRate;

  const config = {
    codec: 'mp4a.40.2', // AAC-LC
    numberOfChannels,
    sampleRate,
    bitrate: AAC_BITRATE,
  };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support || !support.supported) {
    throw new Error(`AAC encoding not supported for ${numberOfChannels}ch @ ${sampleRate}Hz`);
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: { codec: 'aac', numberOfChannels, sampleRate },
    fastStart: 'in-memory', // metadata at the front so the file seeks/plays cleanly
  });

  // WebCodecs reports errors on a separate callback, asynchronously — capture it
  // and surface it after flush() rather than letting it vanish.
  let encodeError = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      try { muxer.addAudioChunk(chunk, meta); }
      catch (e) { encodeError = encodeError || e; }
    },
    error: (e) => { encodeError = encodeError || e; },
  });
  encoder.configure(config);

  // Feed the PCM in ~1s planar blocks: bounds the per-frame allocation and keeps
  // timestamps monotonic. AudioBuffer channels are already planar Float32.
  const left  = audioBuffer.getChannelData(0);
  const right = numberOfChannels === 2 ? audioBuffer.getChannelData(1) : null;
  const total = left.length;
  const BLOCK = sampleRate; // 1 second of frames

  for (let off = 0; off < total; off += BLOCK) {
    if (encodeError) break;
    const n = Math.min(BLOCK, total - off);
    // f32-planar layout: all of channel 0, then all of channel 1.
    const data = new Float32Array(n * numberOfChannels);
    data.set(left.subarray(off, off + n), 0);
    if (right) data.set(right.subarray(off, off + n), n);

    const frame = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: n,
      numberOfChannels,
      timestamp: Math.round((off / sampleRate) * 1e6), // microseconds
      data,
    });
    encoder.encode(frame);
    frame.close();
  }

  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;

  muxer.finalize();
  return muxer.target.buffer;
}
