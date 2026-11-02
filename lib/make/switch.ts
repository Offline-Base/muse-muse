import { env } from "@/lib/env";

/** One box for everything (docs/TRAINING.md): MAKE_CHAT_ALL, and the plan and run routes it reuses need TUNE_COMPOSER. */
export function makeChatAllOn(): boolean {
  return env.makeChatAll && env.tuneComposer;
}
