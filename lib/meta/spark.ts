/** Muse Spark 1.3 is never used on this platform. Anything that would run on it runs on its contributor tier instead. */
export const RETIRED_SPARK = "muse-spark-1.3";
export const SPARK_STANDIN = "muse-spark-1.3-contributor";

/** The model to actually call: Muse Spark 1.3 becomes Spark 1.3 Contributor, anything else stays as it is. */
export function withoutRetiredSpark<T extends string>(model: T): T | typeof SPARK_STANDIN {
  return model === RETIRED_SPARK ? SPARK_STANDIN : model;
}

/**
 * BUILDS_ON_CONTRIBUTOR, the owner's switch: everything on the platform runs on Spark 1.3 Contributor. The one source of
 * truth. lib/env.ts reads it from here, and next.config.ts inlines the setting at build time, so changing it takes a redeploy.
 * What stays on Muse Wonder: WONDER_IN_LOOP's Wonder check, the device route, and keepsWonderUnderSwitch's live products (gadgets,
 * boards, the three demos). lib/__tests__/no-wonder.test.ts fails on any other path to Wonder.
 */
export function contributorSwitchOn(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.BUILDS_ON_CONTRIBUTOR ?? "").trim().toLowerCase());
}

/** What a platform call with no other setting runs on: Contributor under the switch, else Muse Wonder. */
export function defaultModel(): "muse-wonder-1.0" | typeof SPARK_STANDIN {
  return contributorSwitchOn() ? SPARK_STANDIN : "muse-wonder-1.0";
}

/** Told to whoever writes a product under the switch. Its code keeps the id, which the gateway serves on Contributor. */
export const CONTRIBUTOR_PRODUCT_LINE = `Muse Muse runs on ${SPARK_STANDIN} for now. Keep naming muse-wonder-1.0 in the product's code and brief: the gateway serves those calls on ${SPARK_STANDIN}, at its price. Never say Muse Wonder on the product's screens, in a ModelChip, a privacy line or a note: say "an AI model". Audio input is off, so transcribe speech first with muse-voice-transcribe-1.0.`;
