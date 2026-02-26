import WebSocket from "ws";

export function startSTT(onTranscript: (text: string) => void) {
  const ws = new WebSocket(
    "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=48000",
    {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
      }
    }
  );

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.channel?.alternatives?.[0]?.transcript) {
      const transcript = data.channel.alternatives[0].transcript;
      onTranscript(transcript);
    }
  });

  ws.on("open", () => {
    console.log("Connected to Deepgram");
  });

  return ws;
}