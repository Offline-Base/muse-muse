import type { CapCatalogEntry } from "@/lib/caps/catalog";

/** The brief writer's catalog section for the games cap (docs/CAPABILITIES.md, section 20). */
export const GAMES_CATALOG: CapCatalogEntry = {
  name: "game engines (Phaser for 2D, Babylon.js for 3D)",
  block: [
    "- games (game engines): a game in the page on Phaser 4 (2D: sprites, arcade physics, tile levels) or Babylon.js 9 (3D: a small scene of shapes to move through). It plays with a keyboard and with touch, on a phone first. Art is drawn in code or made by Muse Image. 3D models come only from the platform's free CC0 asset set, not reachable from builds yet, so 3D scenes are built from simple shapes for now. No multiplayer, no accounts, progress kept only in the browser, and no files or scripts from other sites.",
  ].join("\n"),
};
