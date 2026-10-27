import type { z } from "zod";

export interface RespondJsonOptions<T> {
  model?: "muse-spark-1.3" | "muse-wonder-1.0";
  schema: z.ZodType<T>;
  schemaName: string;
  instructions?: string;
  input: string | unknown[];
}

/**
 * Asks a Muse model for JSON that matches `schema`, validates the reply, and retries once with the validation error.
 *
 * TODO(kickoff, day 2): implement after the spike confirms how Muse Spark 1.3 takes a JSON schema on the Responses API.
 * Fallback if it doesn't: put the JSON schema in the instructions, then validate with zod.
 */
export async function respondJson<T>(opts: RespondJsonOptions<T>): Promise<T> {
  void opts;
  throw new Error("respondJson is not implemented yet. This repo is a scaffold until kickoff.");
}
