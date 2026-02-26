import axios from "axios";
import { Room, AudioSource, LocalAudioTrack, TrackPublishOptions, AudioFrame } from "@livekit/rtc-node";
import { AgentState } from "./ state";
import { updateState } from "./silence";

let roomInstance: Room;
let audioSource: AudioSource;
let currentTrack: LocalAudioTrack;

export async function registerRoom(room: Room) {
  roomInstance = room;
  audioSource = new AudioSource(48000, 1);
  currentTrack = await LocalAudioTrack.createAudioTrack("agent-audio", audioSource);
  if (roomInstance.localParticipant) {
    await roomInstance.localParticipant.publishTrack(currentTrack, new TrackPublishOptions());
  }
}

export async function speak(text: string) {
  updateState(AgentState.SPEAKING);

  const response = await axios.post(
    "https://api.openai.com/v1/audio/speech",
    {
      model: "gpt-4o-mini-tts",
      input: text,
      voice: "alloy",
      format: "wav"
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      responseType: "arraybuffer"
    }
  );

  const buffer = Buffer.from(response.data);
  const int16Data = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);

  const audioFrame = new AudioFrame(int16Data, 48000, 1, int16Data.length);
  audioSource.captureFrame(audioFrame);

  updateState(AgentState.LISTENING);
}

export function stopSpeaking() {
  // No-op: AudioSource does not have a clear() method
}