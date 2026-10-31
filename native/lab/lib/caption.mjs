// The words that go with a check: the caption burned into the clip and the one sentence for the build room. They say
// what actually ran. A simulator is called a simulator, an emulator an emulator and the mock glasses simulated. Product
// names never go in here: captions come only from the lab's own device facts.

const LAB_NOTE = "Recorded in the Muse Muse device lab. Not an official Meta product.";
const GLASSES_NOTE = "Simulated glasses with a sample photo. Recorded in the Muse Muse device lab. Not an official Meta product.";

/** Device facts come from tool output, so they keep only plain characters. */
function clean(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[^A-Za-z0-9 ._()-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

/** "Pixel 7, Android 15" from the parts that are known. */
function inBrackets(...parts) {
  const known = parts.map(clean).filter(Boolean);
  return known.length ? ` (${known.join(", ")})` : "";
}

/** Where a check ran, as a phrase that follows "On" or "Checked on". */
function place(kind, device = {}) {
  const os = clean(device.os);
  switch (kind) {
    case "ios_sim":
      return `an iPhone simulator${inBrackets(device.name, os && `iOS ${os}`)}`;
    case "glasses_sim":
      return `an iPhone simulator with simulated Meta glasses${inBrackets(device.name, os && `iOS ${os}`)}`;
    case "android_emu":
      return `an Android emulator${inBrackets(device.name, os && `Android ${os}`)}`;
    case "desktop_mac":
      return `a Mac in the AWS device lab${inBrackets(os && `macOS ${os}`)}`;
    case "desktop_windows":
      return `Windows in the AWS device lab${inBrackets(os)}`;
    default:
      return "the device lab";
  }
}

/** The big line in the clip, like "On an Android emulator (Pixel 7, Android 15)". */
export function captionFor(kind, device) {
  return `On ${place(kind, device)}`;
}

/** The small line under the caption. */
export function noteFor(kind) {
  return kind === "glasses_sim" ? GLASSES_NOTE : LAB_NOTE;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/**
 * The sentence the build room shows for a finished check.
 *
 * @param {string} kind
 * @param {object} device
 * @param {{ passed: boolean, reasons?: string[], loadMs?: number | null }} outcome
 */
export function summaryFor(kind, device, outcome) {
  const where = place(kind, device);
  if (outcome.passed) {
    const opened = Number.isFinite(outcome.loadMs) ? `: opened in ${seconds(outcome.loadMs)}` : "";
    return `Checked on ${where}${opened}.`;
  }
  const why = outcome.reasons?.[0];
  return why ? `Didn't pass on ${where}: ${why}` : `Didn't pass on ${where}.`;
}

/** The sentence for a check the lab couldn't run. The product may be fine. */
export function labFailureSummary(kind, device) {
  return `Not checked on ${place(kind, device)}: the device lab ran into a problem.`;
}
