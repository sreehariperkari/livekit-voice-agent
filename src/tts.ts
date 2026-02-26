import axios from "axios";
import { encode as urlEncode } from "querystring";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { PassThrough } from "stream";

import {
  Room,
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

import { AgentState } from "./state";
import { updateState } from "./silence";

ffmpeg.setFfmpegPath(ffmpegPath.path);

let roomInstance: Room;
let audioSource: AudioSource;

// When set to false mid-playback the send loop stops (interruption)
let isSpeaking = false;

const SAMPLE_RATE = 48000;
const CHANNELS = 1;

// 10 ms per frame = 480 samples @ 48 kHz mono
// LiveKit requires a fixed small frame size; one large frame does not play.
const SAMPLES_PER_FRAME = 480;

export async function registerRoom(room: Room): Promise<void> {
  roomInstance = room;
  audioSource = new AudioSource(SAMPLE_RATE, CHANNELS);

  if (!roomInstance.localParticipant) {
    throw new Error(
      "registerRoom(): room.localParticipant is not available. " +
      "Make sure room.connect() has resolved before calling registerRoom()."
    );
  }

  const track = LocalAudioTrack.createAudioTrack("agent-audio", audioSource);
  const publishOptions = new TrackPublishOptions();
  publishOptions.source = TrackSource.SOURCE_MICROPHONE;
  await roomInstance.localParticipant.publishTrack(track, publishOptions);
  console.log("[TTS] Agent audio track published");
}

export async function speak(text: string): Promise<void> {
  if (!roomInstance || !audioSource) {
    console.warn("[TTS] speak() called before registerRoom() — skipping");
    return;
  }

  isSpeaking = true;
  updateState(AgentState.SPEAKING);
  console.log("[TTS] Generating audio for:", JSON.stringify(text));

  try {
    // ── Step 1: fetch MP3 from Google Translate TTS ───────────────────
    const mp3Buffer = await fetchGTTS(text);
    console.log(`[TTS] MP3 fetched: ${mp3Buffer.byteLength} bytes`);

    if (mp3Buffer.byteLength < 100) {
      // Google TTS sometimes returns an HTML error page (~700 bytes) or a
      // tiny response when rate-limited.  Log the raw text so we can debug.
      console.error(
        "[TTS] MP3 response suspiciously small — likely a rate-limit or error:",
        Buffer.from(mp3Buffer).toString("utf8").slice(0, 200)
      );
      return;
    }

    if (!isSpeaking) {
      console.log("[TTS] Interrupted before conversion — aborting");
      return;
    }

    // ── Step 2: convert MP3 → raw s16le PCM via ffmpeg ────────────────
    const pcmBuffer = await convertMp3ToPcm(mp3Buffer);
    console.log(`[TTS] PCM converted: ${pcmBuffer.byteLength} bytes → ${pcmBuffer.byteLength / 2} samples`);

    if (!isSpeaking) {
      console.log("[TTS] Interrupted before playback — aborting");
      return;
    }

    if (pcmBuffer.byteLength === 0) {
      console.error("[TTS] PCM buffer is empty — ffmpeg conversion produced no output");
      return;
    }

    const int16Data = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.byteLength / 2
    );

    const totalFrames = Math.floor(int16Data.length / SAMPLES_PER_FRAME);
    console.log(`[TTS] Sending ${totalFrames} frames (${(totalFrames * 10).toFixed(0)} ms of audio)`);

    // ── Step 3: send PCM in 10ms chunks ──────────────────────────────
    // Sending the entire buffer as one frame does not work — LiveKit requires
    // a steady stream of fixed-duration frames (here: 10ms = 480 samples).
    // We also check isSpeaking between frames to allow mid-utterance interrupts.
    //
    // IMPORTANT: use .slice() not .subarray().
    // subarray() creates a view with a non-zero byteOffset; some native code
    // inside LiveKit's NAPI layer reads data.buffer from offset 0, which would
    // send the wrong bytes.  slice() always produces a fresh zero-offset copy.
    let framesSent = 0;
    for (let offset = 0; offset + SAMPLES_PER_FRAME <= int16Data.length; offset += SAMPLES_PER_FRAME) {
      if (!isSpeaking) {
        console.log(`[TTS] Playback interrupted after ${framesSent} frames`);
        break;
      }

      const chunk = int16Data.slice(offset, offset + SAMPLES_PER_FRAME);
      const frame = new AudioFrame(chunk, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME);
      await audioSource.captureFrame(frame);
      framesSent++;
    }

    console.log(`[TTS] Playback complete — sent ${framesSent}/${totalFrames} frames`);
  } catch (err) {
    console.error("[TTS] Error during speak():", err);
  } finally {
    isSpeaking = false;
    updateState(AgentState.LISTENING);
  }
}

export function stopSpeaking(): void {
  isSpeaking = false;
}

/** True while PCM frames are actively being pushed to LiveKit. */
export function isSpeakingNow(): boolean {
  return isSpeaking;
}

/* --------------------------
   Google Translate TTS
   Free, no API key needed.  May return HTTP 429 under heavy load;
   retry logic is intentionally omitted to keep the code simple.
--------------------------- */
async function fetchGTTS(text: string): Promise<Uint8Array> {
  const url = `https://translate.google.com/translate_tts?${urlEncode({
    ie: "UTF-8",
    q: text,
    tl: "en",
    client: "gtx",
  })}`;

  const response = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; voice-agent/1.0)",
    },
  });

  return new Uint8Array(response.data);
}

/* --------------------------
   MP3 → raw signed-16-bit PCM via ffmpeg
   Pipes through an explicit PassThrough so "end" always fires after
   all "data" events (avoids truncated audio from early resolution).
--------------------------- */
function convertMp3ToPcm(mp3Bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const inputStream = new PassThrough();
    inputStream.end(Buffer.from(mp3Bytes));

    const outputStream = new PassThrough();
    const chunks: Buffer[] = [];

    outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    outputStream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    outputStream.on("error", reject);

    ffmpeg(inputStream)
      .format("s16le")
      .audioFrequency(SAMPLE_RATE)
      .audioChannels(CHANNELS)
      .on("error", reject)
      .pipe(outputStream);
  });
}
