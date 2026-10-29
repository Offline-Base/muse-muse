/** Muse Spark 1.3 is never used on this platform. Anything that would run on it runs on its contributor tier instead. */
export const RETIRED_SPARK = "muse-spark-1.3";
export const SPARK_STANDIN = "muse-spark-1.3-contributor";

/** The model to actually call: Muse Spark 1.3 becomes Spark 1.3 Contributor, anything else stays as it is. */
export function withoutRetiredSpark<T extends string>(model: T): T | typeof SPARK_STANDIN {
  return model === RETIRED_SPARK ? SPARK_STANDIN : model;
}
