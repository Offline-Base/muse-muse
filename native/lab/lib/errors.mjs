// A failure of the lab itself, as opposed to a product that didn't pass its check. The code goes to the platform in
// the finish call (docs/NATIVE_LAB.md, "Lab error codes"), which retries a job once for the codes that can pass on a
// second try.

export const LAB_ERROR_CODES = [
  "invalid_input",
  "tool_missing",
  "download_failed",
  "checksum_mismatch",
  "simulator_failed",
  "emulator_failed",
  "install_failed",
  "timeout",
  "canceled",
  "agent_restarted",
  "internal",
];

/** The codes the platform may retry once. The rest would only fail the same way again. */
export const RETRYABLE_CODES = ["download_failed", "simulator_failed", "emulator_failed", "timeout", "agent_restarted", "internal"];

export class LabError extends Error {
  /**
   * @param {string} code one of LAB_ERROR_CODES
   * @param {string} message a plain sentence, safe to show the owner
   */
  constructor(code, message) {
    super(message);
    this.name = "LabError";
    this.code = LAB_ERROR_CODES.includes(code) ? code : "internal";
  }
}
