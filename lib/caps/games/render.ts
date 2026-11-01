import type { Brief } from "@/lib/brief/schema";
import { ENGINE_LABEL, type GamesBrief } from "@/lib/caps/games/brief";
import type { CapRenderEntry } from "@/lib/caps/render";

/**
 * The games cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 20). Its text names the platform files
 * in template/caps/games and the engine's overlay: the skills, the starter components, lib/platform/assets3d.ts, the
 * engine's helper, tests/caps/games.ts and public/notices/.
 */

function block(brief: Brief): GamesBrief | null {
  return ((brief as { games?: GamesBrief | null }).games ?? null) as GamesBrief | null;
}

const ENGINE = {
  phaser: {
    skill: ".agents/skills/muse-phaser/SKILL.md",
    starter: "components/game/PhaserGame.tsx",
    packages: "`phaser` 4.2.1",
    notice: "/notices/phaser.txt",
    helper: "`addAssetPreview` in `lib/platform/phaser-assets.ts` shows a 3D asset's preview picture as a texture",
  },
  babylon: {
    skill: ".agents/skills/muse-babylon/SKILL.md",
    starter: "components/game/BabylonScene.tsx",
    packages: "`@babylonjs/core` and `@babylonjs/loaders` 9.29.0",
    notice: "/notices/babylonjs.txt",
    helper: "`loadAssetModel` and `loadOwnModel` in `lib/platform/babylon-glb.ts` load GLB models after checking them",
  },
} as const;

export const GAMES_RENDER: CapRenderEntry = {
  title: "Game engine",
  build(brief) {
    const games = block(brief);
    if (!games) return [];
    const e = ENGINE[games.engine];
    return [
      `The brief asks for a game on ${ENGINE_LABEL[games.engine]}: ${games.why}`,
      "",
      `Controls: ${games.controls}`,
      "",
      `- Read \`.agents/skills/muse-games/SKILL.md\` first, then \`${e.skill}\`.`,
      `- ${e.packages} is installed at an exact version. Don't add another game, physics or 3D library.`,
      `- \`${e.starter}\` is a working starting point: a client component that imports the engine inside \`useEffect\` and destroys it on unmount. Build the game from it.`,
      "- The game is one canvas inside an ordinary page built from the template's parts: title, start button, score, how to play and the footer stay outside the canvas.",
      "- Phones first: the canvas fits 390x844 with no sideways scroll. Keys and touch both play it, and the canvas is focusable (`tabIndex={0}`) and focused when the game starts.",
      "- Art is drawn in code, or made with Muse Image when the brief lists it. Never load an engine, decoder, model or script from another site.",
      `- 3D assets: ${e.helper}, against the platform's CC0 asset list (\`lib/platform/assets3d.ts\`). The asset set isn't reachable from this build yet, so build scenes from shapes and don't fetch the list.`,
      `- The engine's license notice ships at \`public/notices/\`. Link it from the game's page as "Open source notices" (\`${e.notice}\`).`,
      "- No stand-in: the game runs in the test browser for real, on software rendering (no graphics card), so keep scenes small and draw the first frame right away.",
      "- Smoke test: start the game, then call `expectGameResponds(page, { key, shots })` from `tests/caps/games.ts`. It checks the canvas drew something and changed after one key press, records both and takes the two judge screenshots.",
      "- `template/AGENTS.md` says to build every screen from the template's parts. The game's canvas is the one exception: the engine draws it. Everything around it still uses the parts.",
      "- `lib/platform/assets3d.ts`, the engine's helper in `lib/platform/`, `public/notices/`, `tests/caps/games.ts` and `scripts/caps/games.mjs` are platform files. Leave them as they are.",
    ];
  },
  refine(brief) {
    const games = block(brief);
    if (!games) return [];
    return [`- The game runs on ${ENGINE_LABEL[games.engine]} (\`.agents/skills/muse-games/SKILL.md\` and \`${ENGINE[games.engine].skill}\`). Keep \`expectGameResponds\` in the smoke test passing.`];
  },
  markdown(brief) {
    const games = block(brief);
    if (!games) return [];
    return [`A game on ${ENGINE_LABEL[games.engine]}. ${games.why}`, "", `Controls: ${games.controls}`];
  },
};
