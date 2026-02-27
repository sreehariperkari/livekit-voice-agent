# LiveKit Voice Agent

A real-time voice agent built with **LiveKit** that:

1. Listens to a user speaking in a LiveKit room
2. Transcribes speech to text via **Deepgram**
3. Replies with `"You said: <text>"` using **Google Translate TTS** (no API key required)
4. Publishes the synthesised speech back into the room as a live audio track
5. Never overlaps: stops speaking immediately if the user interrupts
6. Plays a reminder if the user is silent for 20+ seconds

---

## Architecture

```
Browser (mic)
    │  raw PCM frames (48 kHz, 16-bit, mono)
    ▼
LiveKit Room ──► agent.ts (TrackSubscribed)
                    │
                    ├─► stt.ts ──► Deepgram WebSocket ──► onTranscript(text)
                    │                                           │
                    │                                           ▼
                    │                                      tts.ts (speak)
                    │                                           │
                    │                        fetchGTTS (Google TTS) → MP3
                    │                               │
                    │                        ffmpeg (MP3 → PCM s16le 48 kHz)
                    │                               │
                    │               AudioSource.captureFrame × N  (10 ms chunks)
                    │                               │
                    └──────────────────────── LiveKit Room (agent audio track)
                                                    │
                                               Browser (speaker)
```

---

## No-Overlap Logic (How It Works)

The agent tracks a shared `AgentState` enum:

| State | Meaning |
|---|---|
| `LISTENING` | Ready to receive user speech |
| `PROCESSING` | STT transcript received, TTS being generated |
| `SPEAKING` | TTS audio actively being sent to LiveKit |

**Every incoming audio frame** from the user is checked:

```ts
if (state === AgentState.SPEAKING) {
  stopSpeaking();          // sets isSpeaking = false
  state = AgentState.LISTENING;
}
```

Inside `speak()`, the PCM send loop checks `isSpeaking` **between every 10 ms chunk**:

```ts
for (let offset = 0; offset + 480 <= int16Data.length; offset += 480) {
  if (!isSpeaking) break;   // ← interrupted mid-utterance
  await audioSource.captureFrame(frame);
}
```

This means the agent stops within one incoming audio frame (~20 ms) of the user starting to speak.

**STT is also paused while the agent speaks** to prevent Deepgram from transcribing the agent's own voice output.

---

## Silence Handling

A `setTimeout` of **20 seconds** is reset on every incoming audio frame (`resetSilenceTimer()`). If it fires and the state is still `LISTENING`, the agent says `"Are you still there?"`. The timer is never re-triggered by the agent's own speech.

---

## Setup

### Prerequisites

- Node.js 18+
- A [LiveKit](https://livekit.io) project (free cloud tier works)
- A [Deepgram](https://console.deepgram.com) account (free tier: 200 h/month)

### Install dependencies

```bash
npm install
```

### Configure environment variables

```bash
cp .env.example .env
# Edit .env with your credentials
```
#### Copy the env variables 
```bash
LIVEKIT_URL=wss://revrag-sse-xbp8vkho.livekit.cloud
LIVEKIT_API_KEY=API4DM3QL3Um7po
LIVEKIT_API_SECRET=ZflB9dxyrkKJ4QUfWmj94D7oBZzUwTXHzQx8C8tAycO
DEEPGRAM_API_KEY=205294930af817edc5b1d15bf6e4784949abbc91
ROOM_NAME=test-room
```


### Required environment variables

| Variable | Description |
|---|---|
| `LIVEKIT_URL` | WebSocket URL of your LiveKit server (e.g. `wss://project.livekit.cloud`) |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `ROOM_NAME` | Room name the agent will join |
| `DEEPGRAM_API_KEY` | Deepgram API key for speech-to-text |

### Run

```bash
npm run dev
```

On startup the agent will:
1. Generate a **browser-user token**
2. Construct the LiveKit Meet playground URL:
   ```
   https://meet.livekit.io/custom?liveKitUrl=wss://revrag-sse-xbp8vkho.livekit.cloud&token=<token>
   ```
3. **Automatically open it in your default browser** — no copy-paste needed.

The token is also printed to the console in case you need to share or reuse it.

---

## SDKs & External Services

| Purpose | Library / Service |
|---|---|
| LiveKit room & audio | `@livekit/rtc-node` |
| Token generation | `livekit-server-sdk` |
| Speech-to-text | [Deepgram](https://deepgram.com) (streaming WebSocket) |
| Text-to-speech | [Google Translate TTS](https://translate.google.com/translate_tts) (unofficial, free) |
| MP3 → PCM conversion | `fluent-ffmpeg` + `@ffmpeg-installer/ffmpeg` |

---

## Known Limitations

- **Google Translate TTS** is an unofficial endpoint. It may return HTTP 429 under heavy load or if too many requests are made in a short time. For production use, replace `fetchGTTS` in `src/tts.ts` with a proper TTS provider (ElevenLabs, Google Cloud TTS, AWS Polly, etc.).
- **No reconnection logic**: if the Deepgram WebSocket closes, the agent stops transcribing. Restart with `npm run dev`.
- **One speaker at a time**: the agent subscribes to the first audio track it receives. Multiple simultaneous speakers are not handled.
- The silence reminder fires once and then resets the timer (no replay loop).
