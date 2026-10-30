import type { DemoMap, DemoSpec } from "@/lib/docs/demos/types";
import { startDemos } from "@/lib/docs/demos/start";
import { textDemos } from "@/lib/docs/demos/text";
import { mediaDemos } from "@/lib/docs/demos/media";
import { voiceSamDemos } from "@/lib/docs/demos/voice-sam";
import { protocolsDemos } from "@/lib/docs/demos/protocols";
import { cookbookFundamentalsDemos } from "@/lib/docs/demos/cookbook-fundamentals";
import { cookbookUseCasesDemos } from "@/lib/docs/demos/cookbook-use-cases";
import { cookbookMediaDemos } from "@/lib/docs/demos/cookbook-media";
import { museCodeDemos } from "@/lib/docs/demos/muse-code";
import { museCodeCookbookDemos } from "@/lib/docs/demos/muse-code-cookbook";
import { openWeightsDemos } from "@/lib/docs/demos/open-weights";

/** Every page group's demos. A slug belongs to one group (lib/docs/demos/<group>.ts lists its own). */
const ALL: DemoMap = {
  ...startDemos,
  ...textDemos,
  ...mediaDemos,
  ...voiceSamDemos,
  ...protocolsDemos,
  ...cookbookFundamentalsDemos,
  ...cookbookUseCasesDemos,
  ...cookbookMediaDemos,
  ...museCodeDemos,
  ...museCodeCookbookDemos,
  ...openWeightsDemos,
};

/**
 * The page group each slug belongs to, kept in its own module with no imports (lib/docs/demos/groups.ts) so a test
 * that needs only the slugs doesn't load every group's demos the way this file does.
 */
export { DEMO_GROUPS } from "@/lib/docs/demos/groups";

export function demoFor(slug: string): DemoSpec | null {
  return ALL[slug] ?? null;
}

export function demoSlugs(): string[] {
  return Object.keys(ALL);
}
