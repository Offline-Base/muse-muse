/**
 * The Flash drive card's Carry on: an export that ended without a PASS is carried on with the same export id (the same
 * folder, keeping what is already right), on its own drive when it's back or on the one picked, and the owner's own file
 * points at the owner's script, the only place its link can be signed again.
 *
 *   npx tsx --test lib/device/__tests__/drive-card.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardDrive, ExportState, ExportStatus } from "@/lib/device/drive";
import { carryOn, carryOnBody } from "@/lib/device/drive-card";

const drive = (name: string, identity: string, usable = true): BoardDrive => ({
  name,
  title: `Stick ${name}`,
  bytes: 32e9,
  kind: "USB stick",
  filesystem: "exfat",
  label: "STICK",
  free: 30e9,
  read_only: false,
  identity,
  usable,
  why: usable ? null : "This drive is in use at /mnt, so it's left alone.",
});
const OWN = drive("sda", "0123456789abcdef");
const OTHER = drive("sdb", "fedcba9876543210");
const ended = (state: ExportState, extra: Partial<ExportStatus> = {}): ExportStatus => ({
  export: "exp_00000000abcd",
  state,
  source: "board:support-coach",
  drive: { name: OWN.name, title: OWN.title, bytes: OWN.bytes, kind: OWN.kind, filesystem: OWN.filesystem, label: OWN.label, identity: OWN.identity },
  ...extra,
});

describe("Carry on", () => {
  it("is offered for an export that failed, stopped, or finished with a FAIL, and never for a PASS or one still going", () => {
    for (const status of [ended("failed"), ended("stopped"), ended("done", { result: "FAIL" })]) assert.equal(carryOn(status, [OWN], "")?.by, "card", status.state);
    assert.equal(carryOn(ended("done", { result: "PASS" }), [OWN], ""), null);
    for (const state of ["waiting_for_drive", "checking", "needs_erase", "writing", "needs_urls", "verifying"] as const) assert.equal(carryOn(ended(state), [OWN], ""), null, state);
    assert.equal(carryOn(null, [OWN], ""), null);
  });

  it("uses the export's own drive when it's back, wherever it was plugged in, else the drive picked", () => {
    assert.equal((carryOn(ended("failed"), [OTHER, OWN], "sdb") as { drive: BoardDrive }).drive, OWN);
    assert.equal((carryOn(ended("failed"), [OTHER], "sdb") as { drive: BoardDrive }).drive, OTHER);
    assert.equal((carryOn(ended("failed"), [drive("sda", OWN.identity, false), OTHER], "sdb") as { drive: BoardDrive }).drive, OTHER, "never a drive that can't be used");
    assert.deepEqual(carryOn(ended("failed"), [], ""), { by: "card", drive: null }, "waits for a drive");
  });

  it("sends the owner's own file to the owner's script", () => {
    assert.deepEqual(carryOn(ended("failed", { source: "url" }), [OWN], ""), { by: "script" });
  });

  it("keeps the export's id, so the board writes into the same folder", () => {
    assert.deepEqual(carryOnBody(ended("stopped"), OWN), { resume: "exp_00000000abcd", drive: "sda", identity: OWN.identity });
  });
});
