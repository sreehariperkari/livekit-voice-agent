import { speak } from "./ tts";
import { AgentState } from "./ state";

let silenceTimer: NodeJS.Timeout;
let state: AgentState;

export function updateState(current: AgentState) {
  state = current;
}

export function resetSilenceTimer() {
  clearTimeout(silenceTimer);

  silenceTimer = setTimeout(() => {
    if (state === AgentState.LISTENING) {
      speak("Are you still there?");
    }
  }, 20000);
}