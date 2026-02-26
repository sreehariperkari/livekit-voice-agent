import {
  Room,
  RoomEvent,
  TrackKind,
  RemoteAudioTrack,
  AudioStream,
  AudioFrame,
} from "@livekit/rtc-node";

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

import { AgentState } from "./state";
import { updateState, resetSilenceTimer, setSpeakCallback } from "./silence";
import { startSTT, STTHandle } from "./stt";
import { speak, registerRoom, stopSpeaking, isSpeakingNow } from "./tts";
import { createToken } from "./token";

dotenv.config();

// ----- Shared state -----
let state: AgentState = AgentState.LISTENING;
let stt: STTHandle;

// ── Simple energy-based VAD ───────────────────────────────────────────────────
// Audio frames arrive at ~50 fps even when the user is completely silent.
// If we reset the silence watchdog on every frame it will never fire.
// Instead, only count a frame as "speech" when its RMS energy exceeds a
// threshold that corresponds to roughly -60 dBFS for 16-bit audio.
const SPEECH_RMS_THRESHOLD = 300; // ~-80 dBFS on a 16-bit signed scale

function hasAudioEnergy(frame: AudioFrame): boolean {
  const data = frame.data;
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    sumSq += data[i] * data[i];
  }
  return Math.sqrt(sumSq / data.length) > SPEECH_RMS_THRESHOLD;
}

// ----- Entry point -----
async function startAgent() {
  try {
    // Print browser-user token so a web client can join the same room for testing
    const browserToken = await createToken("browser-user");
    console.log("\nBrowser user token (paste into <livekit_url>/custom):\n", browserToken, "\n");

    const agentToken = await createToken("voice-agent");

    const room = new Room();

    // Wire speak callback into silence module (avoids circular import)
    setSpeakCallback(speak);

    // ── IMPORTANT: connect FIRST, THEN register room ──────────────────────
    // localParticipant is only available after a successful connect().
    await room.connect(process.env.LIVEKIT_URL!, agentToken, {
      autoSubscribe: true,
      dynacast: false,
    });
    console.log("Agent connected to room:", room.name);

    // Now localParticipant exists – publish the audio track
    await registerRoom(room);

    // ── Room event logging ────────────────────────────────────────────────
    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log("Participant connected:", p.identity);
    });
    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      console.log("Participant disconnected:", p.identity);
    });
    room.on(RoomEvent.TrackPublished, (_pub, participant) => {
      console.log("Track published by:", participant.identity);
    });

    // ── Deepgram STT ──────────────────────────────────────────────────────
    stt = startSTT(async (text: string) => {
      // Guard: ignore transcripts that arrive while already responding
      if (state !== AgentState.LISTENING) return;

      console.log("STT final transcript:", text);

      // ── State machine: LISTENING → PROCESSING → SPEAKING → LISTENING ──
      // We set PROCESSING here so concurrent transcripts are dropped.
      // We set SPEAKING before calling speak() so the interrupt check in the
      // audio loop (which compares agent.ts's own `state`) correctly detects
      // that the agent is talking and stops it when the user speaks.
      state = AgentState.PROCESSING;
      updateState(state);

      // Transition to SPEAKING *before* the async TTS call so that any
      // audio frames arriving during the fetch+convert phase also trigger
      // the interrupt logic correctly.
      state = AgentState.SPEAKING;
      updateState(state);

      await speak(`You said: ${text}`);

      // speak()'s finally{} already calls updateState(LISTENING), but we must
      // also update agent.ts's own local `state` variable here.
      state = AgentState.LISTENING;
      updateState(state);
    });

    // ── Incoming audio frames from the remote participant ─────────────────
    // Register this BEFORE the startup greeting so we don't miss any
    // participant who joins while the greeting is still playing.
    room.on(
      RoomEvent.TrackSubscribed,
      async (track, _publication, participant) => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        console.log("Audio stream started from:", participant.identity);

        const audioStream = new AudioStream(track as RemoteAudioTrack);

        try {
          for await (const frame of audioStream) {
            // ── No-overlap: interrupt agent only when user actually speaks ─
            //
            // We gate on hasAudioEnergy() so that silent frames arriving while
            // the agent is fetching/converting audio do NOT trigger a spurious
            // interrupt.  Without this gate, every silent frame during the
            // async MP3 fetch sets isSpeaking=false before playback even starts.
            if (isSpeakingNow() && hasAudioEnergy(frame)) {
              console.log("User interrupted — stopping agent speech");
              stopSpeaking();
              state = AgentState.LISTENING;
              updateState(state);
            }

            // ── VAD-gated silence watchdog reset ─────────────────────────
            // Only count this frame as "user speech" if it carries real
            // energy.  Silence frames (RMS ≈ 0) must NOT reset the timer,
            // otherwise the 20-second watchdog would never fire.
            if (hasAudioEnergy(frame)) {
              resetSilenceTimer();
            }

            // ── Forward PCM to Deepgram (always) ───────────────────────
            // We send audio in ALL states, not just LISTENING.
            // Reason: Deepgram closes the WebSocket after 10 s of receiving
            // no data.  When the agent is SPEAKING we previously stopped
            // sending audio — this killed the connection within one utterance.
            // The keepalive ping in stt.ts is a belt-and-suspenders backup.
            //
            // Transcript gating is handled inside the onTranscript callback
            // above (guard: `if (state !== LISTENING) return`).
            //
            // Buffer.from(...byteOffset, byteLength) is required: Int16Array
            // views can have non-zero byteOffset; passing the raw view sends
            // garbage bytes from offset 0 of the underlying ArrayBuffer.
            const pcmBuffer = Buffer.from(
              frame.data.buffer,
              frame.data.byteOffset,
              frame.data.byteLength,
            );
            stt.sendAudio(pcmBuffer);
          }
        } catch (err) {
          console.error("Audio stream error:", err);
        }
      }
    );

    // ── Start silence watchdog ────────────────────────────────────────────
    // Must be started AFTER TrackSubscribed is registered so the timer is
    // live from the moment we're ready to handle audio.
    resetSilenceTimer();

    // ── Startup greeting ─────────────────────────────────────────────────
    // Played AFTER all handlers are registered so a user who joins during
    // the greeting still has their TrackSubscribed event handled.
    console.log("[Agent] Playing startup greeting…");
    await speak("Hello! I am ready. Please speak and I will repeat what you say.");
    console.log("[Agent] Startup greeting done. Listening…");
  } catch (err) {
    console.error("Agent failed to start:", err);
    process.exit(1);
  }
}

startAgent();