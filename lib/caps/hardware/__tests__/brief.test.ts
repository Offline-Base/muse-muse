/**
 * The hardware cap's brief block, writer rules, catalog, prompts, judge note and token markers (docs/CAPABILITIES.md, section 19).
 *
 *   npx tsx --test lib/caps/hardware/__tests__/brief.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Brief } from "@/lib/brief/schema";
import { BriefSchema, newBriefSchemaFor } from "@/lib/brief/schema";
import { capsWriterRules } from "@/lib/caps/brief-fields";
import { CAP_CATALOG } from "@/lib/caps/catalog";
import { hardwareBlock, hardwareWriterBlock, hardwareWriterRules, HardwareBriefBlock, normalizeHardwareBlock } from "@/lib/caps/hardware/brief";
import { hardwareJudgeNote } from "@/lib/caps/hardware/judge";
import { hardwareOwnerLink } from "@/lib/caps/hardware/owner-link";
import { capsForBuild } from "@/lib/caps/ready";
import { capsBuildLines, capsMarkdown, capsRefineLines } from "@/lib/caps/render";
import { overlaysFor } from "@/lib/caps/overlays";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const SERIAL = { links: ["serial"], boardTools: false, why: "Reads a thermometer on a USB cable." };
const BOARD = { links: [], boardTools: true, why: "Shows a message on the shop's board." };
const brief = (hardware: unknown) => ({ ...BRIEF, hardware }) as Brief;

const toolsUsable = () => {
  process.env.HARDWARE_BOARD_TOOLS = "1";
  process.env.HARDWARE_GADGET_OWNER_CHECK = "1";
};

beforeEach(() => {
  delete process.env.HARDWARE_BOARD_TOOLS;
  delete process.env.HARDWARE_GADGET_OWNER_CHECK;
});

const DRIVE = { links: [], boardTools: false, driveExport: true, why: "Puts the model on the owner's drive." };
const driveUsable = () => {
  process.env.DRIVE_EXPORT_PRODUCTS = "1";
  process.env.HARDWARE_GADGET_OWNER_CHECK = "1";
};

describe("the drive tools in a brief", () => {
  beforeEach(() => {
    delete process.env.DRIVE_EXPORT_PRODUCTS;
  });

  it("with their flags off, nothing of them is anywhere: block, writer, rules, catalog, prompts, judge, token", () => {
    for (const only of [() => undefined, () => (process.env.DRIVE_EXPORT_PRODUCTS = "1"), () => (process.env.HARDWARE_GADGET_OWNER_CHECK = "1")]) {
      delete process.env.DRIVE_EXPORT_PRODUCTS;
      delete process.env.HARDWARE_GADGET_OWNER_CHECK;
      only();
      assert.equal(hardwareBlock(brief(DRIVE)), null);
      assert.deepEqual(hardwareBlock(brief({ ...SERIAL, driveExport: true })), SERIAL);
      assert.equal(normalizeHardwareBlock({ ...DRIVE }), null);
      assert.equal(hardwareWriterBlock(true), HardwareBriefBlock);
      assert.deepEqual(Object.keys(hardwareWriterBlock().shape), ["links", "boardTools", "why"]);
      assert.doesNotMatch(hardwareWriterRules().join("\n"), /driveExport/);
      assert.doesNotMatch(CAP_CATALOG.hardware!.block, /drive/i);
      assert.equal(hardwareJudgeNote(brief({ ...SERIAL, driveExport: true })), "Device readings in this test come from a simulated device.");
      assert.deepEqual(allowedModelsFor(brief({ ...SERIAL, driveExport: true }) as never).filter((m) => m === "drive-tools"), []);
      assert.equal(hardwareOwnerLink({ isOwner: true, liveUrl: "https://x.example", slug: "x", status: "live", brief: brief(DRIVE), served: true }), null);
    }
  });

  it("with them on and a brief that asks, every part says so, in plain words with no em dash", () => {
    driveUsable();
    const asked = brief(DRIVE);
    assert.deepEqual(hardwareBlock(asked), DRIVE);
    assert.deepEqual(normalizeHardwareBlock({ ...DRIVE, driveExport: "yes" }), DRIVE);
    assert.ok("driveExport" in hardwareWriterBlock().shape);
    assert.equal(BriefSchema.safeParse(asked).success, true);
    assert.ok(allowedModelsFor(asked as never).includes("drive-tools"));
    assert.ok(!allowedModelsFor(asked as never).includes("board-tools"), "it brings no board tools");
    assert.ok(!allowedModelsFor(asked as never).includes("muse-gadget"), "and no camera");
    assert.equal(hardwareOwnerLink({ isOwner: true, liveUrl: "https://x.example", slug: "x", status: "live", brief: asked, served: true }), "/api/products/x/owner-pass");
    const words = [...capsBuildLines(asked), ...capsRefineLines(asked), ...capsMarkdown(asked), hardwareJudgeNote(asked), CAP_CATALOG.hardware!.block, ...hardwareWriterRules()].join("\n");
    for (const said of [/exportToDrive/, /needs_confirmation/, /needs_erase/, /checkDriveExport/, /press confirm/, /never erases/, /plugged in/]) assert.match(words, said);
    assert.doesNotMatch(words, /\u2014/);
  });

  it("a brief that doesn't ask gets none of it, with them on", () => {
    driveUsable();
    assert.equal(hardwareBlock(brief(SERIAL))?.driveExport, undefined);
    assert.ok(!allowedModelsFor(brief(SERIAL) as never).includes("drive-tools"));
    assert.doesNotMatch(capsBuildLines(brief(SERIAL)).join("\n"), /exportToDrive/);
  });
});

describe("the hardware block", () => {
  it("is optional on a stored brief, and old briefs still parse", () => {
    assert.equal(BriefSchema.safeParse(BRIEF).success, true);
    assert.equal(BriefSchema.safeParse(brief(SERIAL)).success, true);
    assert.equal(BriefSchema.safeParse(brief({ ...SERIAL, links: ["wifi"] })).success, false);
  });

  it("drops board tools while their flag is off, and is null with nothing left", () => {
    assert.deepEqual(hardwareBlock(brief({ ...SERIAL, boardTools: true })), SERIAL);
    assert.equal(hardwareBlock(brief(BOARD)), null);
    toolsUsable();
    assert.deepEqual(hardwareBlock(brief(BOARD)), BOARD);
    assert.equal(hardwareBlock(BRIEF), null);
  });

  it("cleans what the writer sends", () => {
    const cleaned = normalizeHardwareBlock({ links: ["Web Serial", "BLE", "serial", "wifi"], boardTools: "true", why: "x ".repeat(150) }, true) as { links: string[]; boardTools: boolean; why: string };
    assert.deepEqual(cleaned.links, ["serial", "bluetooth"]);
    assert.equal(cleaned.boardTools, true);
    assert.ok(cleaned.why.length <= 200);
    assert.equal(normalizeHardwareBlock({ links: [], boardTools: true, why: "w" }, false), null, "asks for nothing once board tools are off");
    assert.equal(normalizeHardwareBlock({ links: ["wifi"], boardTools: false, why: "w" }, true), null);
    assert.equal(normalizeHardwareBlock("nope", true), "nope", "left for zod to report");
  });

  it("the writer can't ask for board tools while they're off", () => {
    assert.equal(hardwareWriterBlock(true), HardwareBriefBlock);
    assert.equal(hardwareWriterBlock(false).safeParse(BOARD).success, false);
    assert.equal(hardwareWriterBlock(false).safeParse(SERIAL).success, true);
    assert.match(hardwareWriterRules(false).join("\n"), /boardTools: always false/);
    assert.match(hardwareWriterRules(true).join("\n"), /board's owner has to link it/);
  });

  it("is in the writer's schema and rules only when the cap is enabled", () => {
    const on = newBriefSchemaFor({ gadgets: false, targets: [], caps: ["hardware"], milestones: false });
    assert.ok("hardware" in (on as unknown as { shape: Record<string, unknown> }).shape);
    assert.equal(capsWriterRules([]), "");
    assert.match(capsWriterRules(["hardware"]), /hardware\.links/);
  });
});

describe("what the cap says", () => {
  it("the catalog says where browser links work, and names board tools only while they're on", () => {
    const block = CAP_CATALOG.hardware!.block;
    assert.match(block, /Browser links work in Chrome and Edge on a computer or Android, after a click\. Not in Safari or on iPhone\./);
    assert.doesNotMatch(block, /board tools/);
    toolsUsable();
    assert.match(CAP_CATALOG.hardware!.block, /board tools/);
  });

  it("the build prompt has a Devices section with the helpers and the smoke test", () => {
    const text = capsBuildLines(brief({ ...SERIAL, links: ["serial", "bluetooth"] })).join("\n");
    assert.match(text, /### Devices/);
    assert.match(text, /muse-hardware\/SKILL\.md/);
    assert.match(text, /connectSerial`, `connectBluetooth/);
    assert.match(text, /checkDeviceLink/);
    assert.doesNotMatch(text, /readSensor|checkBoardTool/);
    toolsUsable();
    const both = capsBuildLines(brief({ ...SERIAL, boardTools: true })).join("\n");
    assert.match(both, /readSensor/);
    assert.match(both, /checkBoardTool/);
    assert.match(both, /boardMessage/);
  });

  it("no em dashes and no run_command promise in anything a person or the writer reads", () => {
    toolsUsable();
    const b = brief({ links: ["serial"], boardTools: true, why: "A reason." });
    const text = [...capsBuildLines(b), ...capsRefineLines(b), ...capsMarkdown(b), ...hardwareWriterRules(true), CAP_CATALOG.hardware!.block, hardwareJudgeNote(b)].join("\n");
    assert.equal(text.includes(String.fromCharCode(0x2014)), false);
    assert.doesNotMatch(text, /run_command/);
  });

  it("the judge's note says readings are simulated", () => {
    assert.equal(hardwareJudgeNote(brief(SERIAL)), "Device readings in this test come from a simulated device.");
    assert.equal(hardwareJudgeNote(BRIEF as Brief), "");
  });

  it("a brief gets the overlay", () => {
    assert.deepEqual(overlaysFor(brief(SERIAL)), ["core", "hardware"]);
  });
});

describe("the token's markers", () => {
  const models = (hardware: unknown, capabilities = BRIEF.capabilities) => allowedModelsFor({ ...brief(hardware), capabilities });

  it("board tools have their own marker and never bring the camera and microphone", () => {
    assert.ok(!models(BOARD).includes("board-tools"));
    assert.ok(models(BOARD).includes("cap:hardware"));
    toolsUsable();
    assert.ok(models(BOARD).includes("board-tools"));
    assert.ok(!models(BOARD).includes("muse-gadget"), "only a brief that picked the gadget gets it");
    assert.ok(!models(SERIAL).includes("board-tools"), "browser links never reach a board");
    assert.ok(!models(SERIAL).includes("muse-gadget"));
    assert.ok(models(BOARD, [...BRIEF.capabilities, { need: "see", model: "muse-gadget", why: "a board" }] as Brief["capabilities"]).includes("muse-gadget"));
  });
});

describe("board tools with the owner check off", () => {
  beforeEach(() => {
    process.env.HARDWARE_BOARD_TOOLS = "1";
  });

  it("nothing offers them, and nothing brings them to a token", () => {
    assert.equal(hardwareBlock(brief(BOARD)), null);
    assert.deepEqual(hardwareBlock(brief({ ...SERIAL, boardTools: true })), SERIAL);
    assert.equal(normalizeHardwareBlock(BOARD), null);
    assert.equal(hardwareWriterBlock().safeParse(BOARD).success, false);
    assert.match(hardwareWriterRules().join("\n"), /boardTools: always false/);
    assert.doesNotMatch(CAP_CATALOG.hardware!.block, /board tools/);
    assert.deepEqual(allowedModelsFor(brief(BOARD)).filter((m) => m === "board-tools" || m === "muse-gadget"), []);
  });

  it("a build drops such a block as switched off", () => {
    const enabled = ["hardware"] as const;
    assert.deepEqual(capsForBuild(brief(BOARD), { enabled, onSite: enabled }).dropped, [{ cap: "hardware", reason: "off" }]);
  });

  it("the owner's link doesn't show, since there's no board for the pass to reach", () => {
    assert.equal(hardwareOwnerLink({ isOwner: true, liveUrl: "https://x.example", slug: "x", status: "live", brief: brief(BOARD), served: true }), null);
  });
});

describe("what a writer and a builder read about a board", () => {
  it("the catalog's 'nothing else' stays true, and the prompt says the request has to go along", () => {
    toolsUsable();
    assert.match(CAP_CATALOG.hardware!.block, /Boards do nothing else for a product/);
    const text = capsBuildLines(brief(BOARD)).join("\n");
    assert.match(text, /always pass the incoming request/);
    assert.match(text, /boardMessage/);
    assert.match(text, /own tab/);
  });
});

describe("what a build gets", () => {
  it("a block left with nothing is dropped as switched off, and a link-only block stays", () => {
    const enabled = ["hardware"] as const;
    const { dropped, brief: working } = capsForBuild(brief(BOARD), { enabled, onSite: enabled });
    assert.deepEqual(dropped, [{ cap: "hardware", reason: "off" }]);
    assert.equal((working as { hardware?: unknown }).hardware, null);
    assert.deepEqual(capsForBuild(brief(SERIAL), { enabled, onSite: enabled }).dropped, []);
    toolsUsable();
    assert.deepEqual(capsForBuild(brief(BOARD), { enabled, onSite: enabled }).dropped, []);
  });

  it("the owner's link shows only to an owner of a live product with board tools", () => {
    const on = { isOwner: true, liveUrl: "https://x.example", slug: "x", status: "live", brief: brief(BOARD), served: true };
    assert.equal(hardwareOwnerLink(on, true), "/api/products/x/owner-pass");
    assert.equal(hardwareOwnerLink(on, false), null);
    assert.equal(hardwareOwnerLink({ ...on, isOwner: false }, true), null);
    assert.equal(hardwareOwnerLink({ ...on, served: false }, true), null);
    assert.equal(hardwareOwnerLink({ ...on, brief: brief(SERIAL) }, true), null);
  });
});
