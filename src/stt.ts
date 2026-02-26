import WebSocket from "ws";

// ── Deepgram streaming STT ────────────────────────────────────────────────────
//
// TWO PROBLEMS this module solves:
//
// 1. IDLE TIMEOUT — Deepgram closes the WebSocket after ~10 s of receiving no
//    audio.  This happens every time the agent is speaking (we guard audio
//    forwarding to stop self-transcription).  Fix: send a {"type":"KeepAlive"}
//    text frame every 8 seconds while the connection is open.
//
// 2. NO RECONNECT — once the socket closes, STT is dead.  Fix: auto-reconnect
//    with a 1-second delay whenever the connection closes.
//
// The public interface is an STTHandle with a `sendAudio(Buffer)` method so
// callers never need to check readyState themselves.
// ─────────────────────────────────────────────────────────────────────────────

export interface STTHandle {
  /** Send a raw PCM buffer to Deepgram.  No-op if not yet connected. */
  sendAudio(data: Buffer): void;
}

const KEEPALIVE_MS = 8_000;   // must be < Deepgram's 10-second idle timeout
const RECONNECT_MS = 1_000;

export function startSTT(onTranscript: (text: string) => void): STTHandle {
  let ws: WebSocket | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let dead = false; // set to true on deliberate shutdown (not used yet, guards reconnect)

  function connect(): void {
    console.log("[STT] Connecting to Deepgram…");

    ws = new WebSocket(
      "wss://api.deepgram.com/v1/listen" +
      "?encoding=linear16&sample_rate=48000&channels=1" +
      "&interim_results=true&punctuate=true&endpointing=300",
      {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        },
      }
    );

    ws.on("open", () => {
      console.log("[STT] Connected to Deepgram");

      // ── Keepalive ping ────────────────────────────────────────────────
      // Deepgram closes the stream after 10 s of no audio data.  When the
      // agent is speaking we intentionally stop forwarding user audio (to
      // avoid transcribing the agent's voice).  The keepalive message
      // extends the idle window for another 10 s each time it is sent.
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
          console.log("[STT] KeepAlive sent");
        }
      }, KEEPALIVE_MS);
    });

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as {
          speech_final?: boolean;
          channel?: { alternatives?: Array<{ transcript?: string }> };
        };
        const transcript = data?.channel?.alternatives?.[0]?.transcript;

        if (transcript && data.speech_final === true) {
          console.log("[STT] Final transcript:", transcript);
          onTranscript(transcript);
        }
      } catch (e) {
        console.error("[STT] Message parse error:", e);
      }
    });

    ws.on("error", (err) => {
      // Logged here; the "close" event always follows an "error" event in ws,
      // so reconnect logic lives only in the "close" handler.
      console.error("[STT] WebSocket error:", err.message);
    });

    ws.on("close", (code, reason) => {
      console.warn(
        `[STT] Connection closed — code=${code} reason="${reason.toString() || "none"}"`
      );

      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }

      if (!dead) {
        console.log(`[STT] Reconnecting in ${RECONNECT_MS} ms…`);
        setTimeout(connect, RECONNECT_MS);
      }
    });
  }

  connect();

  return {
    sendAudio(data: Buffer): void {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },
  };
}
