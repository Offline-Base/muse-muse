import { z } from "zod";

/**
 * The games cap's brief block (docs/CAPABILITIES.md, section 20): a game in the page on a real game engine, Phaser 4
 * for 2D or Babylon.js 9 for 3D, each a template overlay (games-phaser, games-babylon) beside the shared `games` one.
 * The contract named the field `gameEngine`. Unit 2's registries key a cap's block by its id (8a), so it is `games`.
 */

export const GAME_ENGINES = ["phaser", "babylon"] as const;
export type GameEngine = (typeof GAME_ENGINES)[number];

/** The template overlay each engine brings, after the shared `games` overlay. */
export const ENGINE_OVERLAY: Record<GameEngine, string> = { phaser: "games-phaser", babylon: "games-babylon" };

/** What each engine is, at the exact version its overlay installs. A template test keeps these in step with deps.json. */
export const ENGINE_LABEL: Record<GameEngine, string> = { phaser: "Phaser 4.2.1", babylon: "Babylon.js 9.29.0" };

export const GamesBriefBlock = z.object({
  engine: z.enum(GAME_ENGINES),
  /** Why this engine fits the game, in one plain sentence. */
  why: z.string().min(1).max(200),
  /** The keys and the touch controls that play it. */
  controls: z.string().min(1).max(200),
});

export type GamesBrief = z.infer<typeof GamesBriefBlock>;

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "").trim() || s.slice(0, max));

const ENGINE_NAMES: Record<string, GameEngine> = { phaser: "phaser", phaserjs: "phaser", babylon: "babylon", babylonjs: "babylon" };

/**
 * The writer's raw games block, cleaned before zod (normalizeRawBrief): the engine's name in its plain id ("Babylon.js"
 * is babylon), text clipped to its limits. A block whose engine isn't one of the two isn't a game on an engine, so it
 * becomes null. So does any block in a brief with the VR target: a VR product runs on the VR overlay's own 3D stack,
 * and the two never mix.
 */
export function normalizeGamesBlock(raw: unknown, brief: { targets?: unknown }): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const targets = Array.isArray(brief.targets) ? brief.targets : [];
  if (targets.some((t) => (t as { id?: unknown })?.id === "vr")) return null;
  const b = { ...(raw as Record<string, unknown>) };
  if (typeof b.engine === "string") {
    const engine = ENGINE_NAMES[b.engine.trim().toLowerCase().replace(/[\s.]+/g, "")];
    if (!engine) return null;
    b.engine = engine;
  }
  for (const key of ["why", "controls"] as const) if (typeof b[key] === "string") b[key] = clip((b[key] as string).trim(), 200);
  return b;
}

/** The writer's rules for the block (lib/caps/brief-fields.ts, CAP_WRITER_RULES). */
export const GAMES_WRITER_RULES: readonly string[] = [
  "games: fill it only for a game or a playful scene that needs a game loop: moving sprites, collisions, physics, levels, or a 3D scene to move through. Otherwise null. A quiz, a board game made of buttons, a card sorter or a word puzzle is an ordinary product and needs no engine.",
  "games.engine: phaser for 2D games (platformers, top-down, arcade, tile puzzles, card and board games with motion); babylon for 3D (a scene to steer or fly through, 3D pieces to arrange, a model to play with).",
  "games.controls: the keys and the touch controls that play it, like \"Arrow keys or hold the left or right side to steer, Space or tap to jump\". Every game plays with a keyboard and with touch.",
  "A game draws its art in code or with Muse Image when the brief lists it. 3D models come only from the platform's free CC0 asset set, which builds can't reach yet, so a 3D game is built from simple shapes for now. No multiplayer, nothing saved beyond the browser.",
  "A product with the vr target never fills games: VR has its own 3D stack.",
];
