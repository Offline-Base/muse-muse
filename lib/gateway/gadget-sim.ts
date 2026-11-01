/**
 * The simulated robot and model a build gets, with no imports: a local test build copies this file into the product. The same
 * actions and limits as muse-device/sim_board.py. Nothing here moves hardware or loads a model, and every answer says so.
 */

/** Everything a robot may ever do here, with each argument's limits. Anything else is refused. */
export const ROBOT_ACTIONS: Record<string, { label: string; args: Record<string, { min: number; max: number; unit: string }> }> = {
  fan_run: { label: "Run the fan", args: { seconds: { min: 1, max: 30, unit: "seconds" } } },
  pump_run: { label: "Run the water pump", args: { seconds: { min: 1, max: 5, unit: "seconds" } } },
  light_set: { label: "Set the light", args: { percent: { min: 0, max: 100, unit: "percent" } } },
};

/** Why this action can't happen, or null. Checked on the platform and again on the board. */
export function robotActionProblem(action: unknown, args: unknown): string | null {
  const known = typeof action === "string" && Object.hasOwn(ROBOT_ACTIONS, action) ? ROBOT_ACTIONS[action] : null;
  if (!known) return `action must be one of ${Object.keys(ROBOT_ACTIONS).join(", ")}.`;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "args must be an object.";
  const given = args as Record<string, unknown>;
  const names = Object.keys(known.args);
  if (Object.keys(given).length !== names.length || names.some((n) => !(n in given))) return `${action} takes ${names.join(", ")}.`;
  for (const name of names) {
    const { min, max } = known.args[name];
    const value = given[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return `${name} must be a whole number from ${min} to ${max}.`;
  }
  return null;
}

/** What the owner reads before saying yes. */
export function robotActionLines(action: string, args: Record<string, number>): { title: string; lines: string[] } {
  const known = ROBOT_ACTIONS[action];
  return {
    title: `${known.label}?`,
    lines: Object.entries(known.args).map(([name, limit]) => `${args[name]} ${limit.unit}. The limit is ${limit.max}.`),
  };
}

export interface SimStatus {
  simulated: true;
  stopped: boolean;
  sensors: Array<{ name: string; kind: string; value: number; unit: string }>;
  actuators: { fan: boolean; pump: boolean; light: number };
  log: Array<Record<string, unknown>>;
}

export function newSimRobot() {
  const state = { soil: 22, temp: 33, light: 40, fanUntil: 0, pumpUntil: 0, stopped: false, log: [] as Array<Record<string, unknown>> };
  const status = (): SimStatus => ({
    simulated: true,
    stopped: state.stopped,
    sensors: [
      { name: "soil-moisture", kind: "moisture", value: Math.round(state.soil * 10) / 10, unit: "%" },
      { name: "air-temp", kind: "temperature", value: Math.round(state.temp * 10) / 10, unit: "C" },
    ],
    actuators: { fan: state.fanUntil > Date.now(), pump: state.pumpUntil > Date.now(), light: state.light },
    log: state.log.slice(-10),
  });
  return {
    status,
    /** The action, or the words saying why not. */
    act(action: string, args: Record<string, number>): SimStatus | string {
      const problem = robotActionProblem(action, args);
      if (problem) return problem;
      if (state.stopped) return "The hard stop is on. The owner has to clear it first.";
      if (action === "fan_run") {
        state.fanUntil = Date.now() + args.seconds * 1000;
        state.temp -= 0.4 * args.seconds;
      } else if (action === "pump_run") {
        state.pumpUntil = Date.now() + args.seconds * 1000;
        state.soil = Math.min(100, state.soil + 8 * args.seconds);
      } else {
        state.light = args.percent;
      }
      state.log.push({ at: Math.floor(Date.now() / 1000), action, ...args });
      return status();
    },
    stop(): SimStatus {
      state.stopped = true;
      state.fanUntil = 0;
      state.pumpUntil = 0;
      state.log.push({ at: Math.floor(Date.now() / 1000), action: "hard_stop" });
      return status();
    },
    clear(): SimStatus {
      state.stopped = false;
      state.log.push({ at: Math.floor(Date.now() / 1000), action: "clear_stop" });
      return status();
    },
  };
}

/** A fixed rule, not a model: it reads numbers like "soil 22" from the last message. muse-device/sim_board.py answers the same way. */
export function simulatedAnswer(target: string, messages: ReadonlyArray<{ role: string; content: string }>): string {
  const text = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const soil = /(?:soil|moisture)\D{0,20}(\d+(?:\.\d+)?)/i.exec(text);
  const temp = /(?:temp|temperature)\D{0,20}(\d+(?:\.\d+)?)/i.exec(text);
  let advice: string;
  if (soil && Number(soil[1]) < 30) advice = `The soil is dry at ${soil[1]}%. Run the pump for 3 seconds.`;
  else if (temp && Number(temp[1]) > 30) advice = `It's warm at ${temp[1]} C. Run the fan for 10 seconds.`;
  else if (soil || temp) advice = "Everything looks fine. Nothing to do.";
  else advice = `I read: ${text.slice(0, 120)}`;
  return `[simulated ${target}] ${advice}`;
}

/** The model a simulated build's board runs: a build stands in for a Jetson, the owner's first target. */
export const SIM_TARGET = { id: "muse-glimmer-30b-IQ1_S", label: "Muse Glimmer, one bit" };
