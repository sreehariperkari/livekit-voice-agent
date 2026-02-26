import { AccessToken } from "livekit-server-sdk";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env"), override: true });

// In livekit-server-sdk v2, toJwt() returns Promise<string>
export async function createToken(identity: string): Promise<string> {
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