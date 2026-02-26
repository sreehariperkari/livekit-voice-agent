import {
  Room,
  RoomEvent,
  TrackKind,
  RemoteAudioTrack,
  AudioStream,
} from "@livekit/rtc-node";

import dotenv from "dotenv";
import WebSocket from "ws";

import { AgentState } from "./ state";
import { updateState, resetSilenceTimer } from "./silence";
import { startSTT } from "./ stt";
import { speak, registerRoom, stopSpeaking } from "./ tts";
import { createToken } from "./token";

dotenv.config();

let state: AgentState = AgentState.LISTENING;

let sttSocket: WebSocket;

async function startAgent() {
  try{} 


    // ✅ Agent joins as voice-agent
    const token = await createToken("voice-agent");
console.log(createToken("browser-user"));
    const room = new Room();
    registerRoom(room)

    await room.connect(process.env.LIVEKIT_URL!, token, {
      autoSubscribe: true,
      dynacast: false,
    });


    console.log("Connected to room:", room.name);

    // 🔎 Debug room events
    room
      .on(RoomEvent.ParticipantConnected, (p) => {
        console.log("Participant connected:", p.identity);
      })
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        console.log("Participant disconnected:", p.identity);
      })
      .on(RoomEvent.TrackPublished, (_pub, participant) => {
        console.log("Track published by:", participant.identity);
      })
      .on(RoomEvent.TrackSubscribed, (_track, _pub, participant) => {
        console.log("Track subscribed from:", participant.identity);
      });

    // ✅ Start Deepgram STT
    sttSocket = startSTT(async (text: string): Promise<void> => {
      console.log("Transcript received:", text);

      state = AgentState.PROCESSING;
      updateState(state);

      await speak(`You said: ${text}`);

      state = AgentState.LISTENING;
      updateState(state);
    });

    // 🎤 Handle incoming audio
    room.on(
      RoomEvent.TrackSubscribed,
      async (track, _publication, participant) => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;

        console.log("Audio track detected from:", participant.identity);

        const audioStream = new AudioStream(track as RemoteAudioTrack);

        for await (const frame of audioStream) {
          // 🔥 Interrupt if user speaks while agent is speaking
          if (state === AgentState.SPEAKING) {
            console.log("User interrupted — stopping agent speech");
            stopSpeaking();
            state = AgentState.LISTENING;
            updateState(state);
          }

          resetSilenceTimer();

          // Send raw PCM frame to Deepgram
          if (sttSocket?.readyState === WebSocket.OPEN) {
            sttSocket.send(frame.data);
          }
        }
      }
    );
  } catch (err) {
    console.error("Agent failed to start:", err);
  }
}

startAgent();