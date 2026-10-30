/**
 * The composer keys from "Steer a running turn" (content/meta-docs/pages/muse-code/interactive.md), as a reducer over
 * a pretend session: Enter steers a running turn (or starts one when idle), Alt+Enter queues for the next turn, Esc
 * interrupts (it never stops background work, and it pauses an unfinished goal), Esc on an empty composer retracts the
 * newest queued instruction, Ctrl+C interrupts only from an empty composer and clears text otherwise, and Esc twice
 * from an idle, empty composer opens the rewind picker. Queued text starts the next turn when the current one ends.
 */

export interface ComposerState {
  running: boolean;
  composer: string;
  /** Instructions held for the next turn, oldest first. */
  queue: string[];
  /** Turns so far, with the instructions steered into each. */
  turns: Array<{ prompt: string; steered: string[]; ended: "running" | "finished" | "interrupted" }>;
  background: boolean;
  goal: "none" | "active" | "paused";
  /** The first Esc of the rewind gesture was pressed. */
  escArmed: boolean;
  /** What the last key did, for the screen reader and the log. */
  last: string;
  log: string[];
}

export type ComposerAction =
  | { type: "text"; value: string }
  | { type: "key"; key: "Enter" | "Alt+Enter" | "Esc" | "Ctrl+C" }
  | { type: "finish" }
  | { type: "background"; on: boolean }
  | { type: "goal"; on: boolean }
  | { type: "reset" };

export const INITIAL_COMPOSER: ComposerState = {
  running: false,
  composer: "",
  queue: [],
  turns: [],
  background: false,
  goal: "none",
  escArmed: false,
  last: "Idle. Type a prompt and press Enter to start a turn.",
  log: [],
};

function say(state: ComposerState, last: string, patch: Partial<ComposerState> = {}): ComposerState {
  return { ...state, ...patch, last, log: [...state.log, last].slice(-12) };
}

function startTurn(state: ComposerState, prompt: string, last: string, patch: Partial<ComposerState> = {}): ComposerState {
  return say(state, last, {
    ...patch,
    running: true,
    escArmed: false,
    turns: [...state.turns, { prompt, steered: [], ended: "running" }],
  });
}

function markCurrent(state: ComposerState, ended: "finished" | "interrupted"): ComposerState["turns"] {
  return state.turns.map((t, i) => (i === state.turns.length - 1 && t.ended === "running" ? { ...t, ended } : t));
}

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case "reset":
      return INITIAL_COMPOSER;
    case "text":
      return { ...state, composer: action.value, escArmed: false };
    case "background":
      return say(state, action.on ? "A background command is running (a long test run, say)." : "The background command finished.", { background: action.on });
    case "goal":
      return say(state, action.on ? "Goal set: the runtime keeps the agent working toward it." : "Goal cleared.", { goal: action.on ? "active" : "none" });
    case "finish": {
      if (!state.running) return say(state, "No turn is running.");
      const turns = markCurrent(state, "finished");
      if (state.queue.length) {
        const prompt = state.queue.join("\n");
        return startTurn({ ...state, turns, queue: [] }, prompt, `The turn finished. ${state.queue.length === 1 ? "The queued instruction starts" : "The queued instructions start"} the next turn.`);
      }
      return say(state, "The turn finished. Muse Code is idle.", { running: false, turns });
    }
    case "key": {
      const text = state.composer.trim();
      switch (action.key) {
        case "Enter": {
          if (!text) return say(state, "Enter with an empty composer does nothing.", { escArmed: false });
          if (state.running) {
            const turns = state.turns.map((t, i) => (i === state.turns.length - 1 ? { ...t, steered: [...t.steered, text] } : t));
            return say(state, `Steered: "${text}" joins the running turn at the agent's next step.`, { composer: "", turns, escArmed: false });
          }
          return startTurn(state, text, `Started a turn: "${text}".`, { composer: "" });
        }
        case "Alt+Enter": {
          if (!text) return say(state, "Nothing to queue.");
          if (!state.running) return say(state, "No turn is running, so there is nothing to queue behind. Press Enter to start one.");
          return say(state, `Queued: "${text}" waits for the next turn.`, { composer: "", queue: [...state.queue, text], escArmed: false });
        }
        case "Esc": {
          if (!text && state.queue.length) {
            const queue = state.queue.slice(0, -1);
            const back = state.queue[state.queue.length - 1];
            return say(state, `Retracted the newest queued instruction into the composer: "${back}". Press Esc again for the one before it.`, { queue, composer: back, escArmed: false });
          }
          if (state.running) {
            const notes = [state.background ? "Background work keeps running: Esc doesn't stop it, so Muse Code reminds you to run /stop." : "", state.goal === "active" ? "The unfinished goal is paused; /goal resume restarts it." : ""].filter(Boolean);
            return say(state, ["Interrupted: the current turn is cancelled.", ...notes].join(" "), { running: false, turns: markCurrent(state, "interrupted"), goal: state.goal === "active" ? "paused" : state.goal, escArmed: false });
          }
          if (text) return say(state, "Esc on a draft doesn't start the rewind gesture.", { escArmed: false });
          if (state.escArmed) return say(state, "Esc twice from an idle, empty composer: the rewind picker opens.", { escArmed: false });
          return say(state, "Esc again to rewind.", { escArmed: true });
        }
        case "Ctrl+C": {
          if (text) return say(state, "Ctrl+C with text in the composer clears the input.", { composer: "", escArmed: false });
          if (state.running) {
            const notes = state.background ? " Background work keeps running; /stop stops it." : "";
            return say(state, `Ctrl+C from an empty composer interrupts the turn.${notes}`, { running: false, turns: markCurrent(state, "interrupted"), goal: state.goal === "active" ? "paused" : state.goal, escArmed: false });
          }
          return say(state, "Nothing is running to interrupt.", { escArmed: false });
        }
      }
    }
  }
  return state;
}
