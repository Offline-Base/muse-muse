/**
 * The games cap (docs/CAPABILITIES.md, section 20): its brief block, the writer's rules and catalog, the build prompt's
 * section, the overlays a brief gets (the shared games overlay, then its engine's), the judge's note, and that the
 * engine versions named here match what the overlays install and what their checker expects.
 *   npx tsx --test lib/caps/games/__tests__/games.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { briefToMarkdown, renderBuildPrompt } from "@/lib/brief/render";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { BriefSchema, newBriefSchemaFor, type Brief } from "@/lib/brief/schema";
import { capsWriterRules } from "@/lib/caps/brief-fields";
import { capsCatalogBlocks, howProductsRun } from "@/lib/caps/catalog";
import { capBuildEnv, capDeployEnv } from "@/lib/caps/env";
import { ENGINE_LABEL, ENGINE_OVERLAY, GAME_ENGINES, GamesBriefBlock, normalizeGamesBlock, type GamesBrief } from "@/lib/caps/games/brief";
import { capBuildHosts } from "@/lib/caps/hosts";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { capsFileFor, overlaysFor } from "@/lib/caps/overlays";
import { capsBuildLines, capsMarkdown, capsRefineLines } from "@/lib/caps/render";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const TEMPLATE = path.join(import.meta.dirname, "../../../../template");
const PHASER: GamesBrief = { engine: "phaser", why: "A 2D arcade game with sprites and collisions.", controls: "Arrow keys or hold the left or right side to steer" };
const BABYLON: GamesBrief = { engine: "babylon", why: "A small 3D track to steer through.", controls: "Arrow keys, or hold the left or right side" };
const withGames = (games: GamesBrief) => ({ ...BRIEF, games }) as Brief;
const render = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };

describe("the games brief block", () => {
  it("is an optional field of the stored brief, and in the writer's schema only when the cap is on", () => {
    assert.deepEqual(BriefSchema.parse(withGames(PHASER)).games, PHASER);
    assert.equal(BriefSchema.parse(BRIEF).games, undefined);
    const on = newBriefSchemaFor({ gadgets: false, targets: [], caps: ["games"] });
    assert.equal(on.safeParse(BRIEF).success, false);
    assert.equal(on.safeParse({ ...BRIEF, games: null }).success, true);
    assert.equal(on.safeParse(withGames(BABYLON)).success, true);
    assert.equal(GamesBriefBlock.safeParse({ ...PHASER, engine: "unity" }).success, false);
    assert.equal(GamesBriefBlock.safeParse({ ...PHASER, controls: "" }).success, false);
  });

  it("is cleaned before zod: the engine's plain id, text clipped, null for another engine or a VR product", () => {
    assert.equal((normalizeGamesBlock({ ...PHASER, engine: "Babylon.js" }, {}) as GamesBrief).engine, "babylon");
    assert.equal((normalizeGamesBlock({ ...PHASER, engine: " Phaser " }, {}) as GamesBrief).engine, "phaser");
    assert.equal(normalizeGamesBlock({ ...PHASER, engine: "three.js" }, {}), null);
    assert.equal(normalizeGamesBlock(PHASER, { targets: [{ id: "web" }, { id: "vr" }] }), null);
    assert.ok((normalizeGamesBlock({ ...PHASER, why: "x".repeat(300) }, {}) as GamesBrief).why.length <= 200);
    const vr = normalizeRawBrief({ ...BRIEF, targets: [{ id: "web", why: "a" }, { id: "vr", why: "b" }], games: BABYLON }, []) as { games: unknown };
    assert.equal(vr.games, null);
    const kept = normalizeRawBrief({ ...BRIEF, games: { ...BABYLON, engine: "BabylonJS" } }, []) as { games: GamesBrief };
    assert.equal(kept.games.engine, "babylon");
  });
});

describe("the writer's rules, catalog and judge note", () => {
  it("say when a game needs an engine and which, only when the cap is on", () => {
    const rules = capsWriterRules(["games"]);
    assert.match(rules, /games: fill it only for a game or a playful scene that needs a game loop/);
    assert.match(rules, /phaser for 2D games/);
    assert.match(rules, /never fills games/);
    assert.match(capsCatalogBlocks(["games"]).join("\n"), /games \(game engines\): a game in the page on Phaser 4/);
    assert.match(howProductsRun(["games"], { gadgets: false })!.first, /add game engines \(Phaser for 2D, Babylon\.js for 3D\)/);
    assert.match(capsJudgeNotes(withGames(PHASER)), /software rendering, so plain lighting and jagged edges are expected/);
    for (const text of [rules, capsCatalogBlocks(["games"]).join("\n"), capsJudgeNotes(withGames(PHASER))]) assert.ok(!text.includes("—"));
  });

  it("names both caps together in plan order", () => {
    assert.match(howProductsRun(["runtime", "extension", "games"], { gadgets: false })!.first, /add small Python functions, a browser extension and game engines/);
  });
});

describe("the build prompt", () => {
  it("has a Game engine section for each engine, naming its skill, starter, helper, notices and the smoke helper", () => {
    for (const [games, wants] of [
      [PHASER, ["Phaser 4.2.1", ".agents/skills/muse-phaser/SKILL.md", "components/game/PhaserGame.tsx", "addAssetPreview", "/notices/phaser.txt"]],
      [BABYLON, ["Babylon.js 9.29.0", ".agents/skills/muse-babylon/SKILL.md", "components/game/BabylonScene.tsx", "loadAssetModel", "/notices/babylonjs.txt"]],
    ] as const) {
      const lines = capsBuildLines(withGames(games)).join("\n");
      assert.match(lines, /^\n## Platform services\n\n### Game engine\n\nThe brief asks for a game on /);
      for (const want of [...wants, ".agents/skills/muse-games/SKILL.md", "expectGameResponds(page, { key, shots })", "Controls: ", "software rendering", "`template/AGENTS.md` says to build every screen from the template's parts"]) {
        assert.ok(lines.includes(want), `${games.engine}: ${want}`);
      }
      assert.ok(!lines.includes("—"));
    }
    assert.ok(renderBuildPrompt(withGames(PHASER), render).includes("### Game engine"));
    assert.match(capsRefineLines(withGames(BABYLON)).join("\n"), /Babylon\.js 9\.29\.0/);
    assert.match(capsMarkdown(withGames(PHASER)).join("\n"), /\*\*Game engine\*\*[\s\S]*A game on Phaser 4\.2\.1/);
    assert.ok(briefToMarkdown(withGames(PHASER)).includes("Game engine"));
  });
});

describe("the build sandbox", () => {
  it("gets core, the shared games overlay and its engine's, and nothing else of its own", () => {
    assert.deepEqual(overlaysFor(withGames(PHASER)), ["core", "games", "games-phaser"]);
    assert.deepEqual(overlaysFor(withGames(BABYLON)), ["core", "games", "games-babylon"]);
    assert.deepEqual(capsFileFor(withGames(BABYLON)), { caps: ["games"], overlays: ["core", "games", "games-babylon"] });
    assert.deepEqual(overlaysFor({ ...withGames(PHASER), extension: { does: "x", permissions: [] } } as Brief), ["core", "extension", "games", "games-phaser"]);
    assert.equal(capBuildEnv(withGames(PHASER)), "");
    assert.deepEqual(capDeployEnv(withGames(PHASER), "mm_live_x"), {});
    assert.deepEqual(capBuildHosts(["games"]), []);
    assert.ok(allowedModelsFor(withGames(PHASER)).includes("cap:games"));
  });
});

describe("the engine versions", () => {
  it("match what each overlay installs, at exact versions, and what its checker expects", async () => {
    const checker = await import(pathToFileURL(path.join(TEMPLATE, "caps/games/files/scripts/caps/games.mjs")).href);
    for (const engine of GAME_ENGINES) {
      const overlay = ENGINE_OVERLAY[engine];
      const deps = JSON.parse(readFileSync(path.join(TEMPLATE, "caps", overlay, "deps.json"), "utf8")) as { dependencies: Record<string, string> };
      for (const [name, version] of Object.entries(checker.ENGINES[overlay].packages as Record<string, string>)) {
        assert.equal(deps.dependencies[name], version, `${overlay} ${name}`);
      }
      for (const version of Object.values(deps.dependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, "exact versions only");
      assert.ok(ENGINE_LABEL[engine].endsWith(Object.values(checker.ENGINES[overlay].packages as Record<string, string>)[0]!), ENGINE_LABEL[engine]);
    }
    assert.deepEqual(Object.keys(checker.ENGINES), Object.values(ENGINE_OVERLAY));
  });
});
