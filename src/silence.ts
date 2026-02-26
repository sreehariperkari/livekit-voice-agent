import { AgentState } from "./state";

// Callback set by agent.ts to avoid circular dependency:
// silence.ts ← agent.ts → tts.ts ← silence.ts (would be circular)
let speakCallback: ((text: string) => Promise<void>) | null = null;

export function setSpeakCallback(fn: (text: string) => Promise<void>): void {
  speakCallback = fn;
}

let silenceTimer: ReturnType<typeof setTimeout>;
let state: AgentState = AgentState.LISTENING;

export function updateState(current: AgentState): void {
  state = current;
}

export function resetSilenceTimer(): void {
  clearTimeout(silenceTimer);

  silenceTimer = setTimeout(() => {
    if (state === AgentState.LISTENING && speakCallback) {
      speakCallback("Are you still there?")
        .then(() => {
          // Restart the watchdog after the reminder finishes so it can fire
          // again if the user stays silent.  This is NOT a continuous loop —
          // the timer only fires after another full 20 seconds of silence.
          resetSilenceTimer();
        })
        .catch((err) => console.error("Silence prompt error:", err));
    }
  }, 20000);
}