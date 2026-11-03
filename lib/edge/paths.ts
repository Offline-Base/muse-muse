/** The template files an edge build gets, by their path in template/ and in the product. */
export const EDGE_TEMPLATE_PATHS = [
  ".agents/skills/muse-edge/SKILL.md",
  "app/api/board-status/route.ts",
  "components/BoardStatus.tsx",
  "lib/meta/board-status.ts",
  "lib/meta/edge.ts",
  "scripts/edge-blackhole.mjs",
  "scripts/edge-drill.mjs",
  "scripts/edge-fake.mjs",
] as const;
