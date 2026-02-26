import { AccessToken } from "livekit-server-sdk";
import dotenv from "dotenv";

dotenv.config();

export function createToken(identity: string) {
  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    { identity }
  );

  at.addGrant({
    room: process.env.ROOM_NAME!,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });

  return at.toJwt();
}