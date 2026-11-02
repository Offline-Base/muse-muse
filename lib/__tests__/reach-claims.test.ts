/**
 * Copy can't say a path is private when it isn't. lib/inference/reach.ts says who can read the text on each path to a model on
 * hardware. This fails if a non-private row's words, docs/GADGETS.md's table or the words around it, or the gadget and fleet copy
 * listed here, claim otherwise.
 *
 * What it can't catch: paraphrases. "Your words go no further" and "it never goes past your board" pass, because this reads for
 * phrases, not meaning. A claim wrapped onto a second line is caught, but not one spread over three lines or split across a
 * string concatenation. It reads only COPY_FILES, not the copy a build writes for its own product. The jetson-infra paths in a
 * row are another repo, so nothing here checks them.
 *
 * Not in COPY_FILES: template/.agents/skills/meta-glimmer/SKILL.md, lib/prompts/catalog.ts, privacy/README.md and
 * privacy/docs/OTHER_APPS.md. Their overclaims were reworded on Nov 2 (docs/BUILD_LOG.md); the template's words reach builds
 * only with a new builder snapshot.
 *
 *   npx tsx --test lib/__tests__/reach-claims.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkBoardAddress } from "@/lib/caps/hardware/board";
import { REACH, type ReachRow } from "@/lib/inference/reach";

const CLAIMS = [
  /\bstays? on your (?:own )?(?:device|board|machine|computer|hardware|laptop|jetson)\b/i,
  /\bon[- ]device\b/i,
  /\bprivate(?:ly)?\b/i,
  /\bprivacy[- ](?:preserving|first|safe)\b/i,
  /\bend-to-end\b/i,
  /\b(?:never|nothing) leaves\b/i,
  /\b(?:nothing|nobody|no one) (?:keeps|stores|logs|reads|sees)\b/i,
];
/** Saying a path isn't private is the point, and a link to /private is no claim. "not only private" still counts. */
const NOT_A_CLAIM = /\b(?:isn['’]t|aren['’]t|is not|are not|not)\s+private\b|\/private\b/gi;

function claimsIn(line: string): string[] {
  const words = line.replace(/&apos;|&#x27;/g, "'").replace(NOT_A_CLAIM, "");
  return CLAIMS.flatMap((claim) => words.match(claim)?.[0] ?? []);
}

/** A claim a formatter wrapped: "stay on your" at the end of one line and "device." at the start of the next. */
function wrappedClaimsIn(line: string, next: string): string[] {
  if (!line.trim() || !next.trim()) return [];
  const alone = [...claimsIn(line), ...claimsIn(next)];
  return claimsIn(`${line.trim()} ${next.trim().replace(/^(?:\/\/+|\*)\s*/, "")}`).filter((claim) => !alone.includes(claim));
}

/** The gadget and fleet copy, as read by people and by the agents who write a product's. */
const COPY_FILES = [
  "app/gadgets/page.tsx",
  "app/try-board/[id]/page.tsx",
  "components/gadgets/BoardsSlot.tsx",
  "components/gadgets/ConfirmAction.tsx",
  "components/gadgets/ConnectBoards.tsx",
  "components/gadgets/OwnBoards.tsx",
  "components/gadgets/PairBoard.tsx",
  "components/gadgets/info.ts",
  "components/device/DeviceAsk.tsx",
  "components/device/DeviceBoards.tsx",
  "components/device/DeviceDrive.tsx",
  "components/device/DeviceTrain.tsx",
  "components/board-loop/BoardTry.tsx",
  "components/board-loop/BoardLoopRoom.tsx",
  "components/board-loop/BoardLoopSlot.tsx",
  "components/board-loop/BoardLoopStart.tsx",
  "components/story/OfflineBody.tsx",
  "lib/story/flow.ts",
  "lib/board-loop/logic.ts",
  "lib/caps/hardware/render.ts",
  "lib/gateway/gadget-connect.ts",
  "template/.agents/skills/muse-gadget/SKILL.md",
  "template/caps/hardware/files/.agents/skills/muse-hardware/SKILL.md",
  "docs/GADGETS.md",
];

/** Lines that use the words and make no claim about a person's text. Each must still be there, so an old entry can't linger. */
const ALLOWED = [
  { file: "components/gadgets/info.ts", line: 'role: "On-device vision"', why: "a Coral board's own NPU. No product's text reaches a Coral" },
  { file: "components/story/OfflineBody.tsx", line: "Private files are a separate question", why: "says running offline isn't the private path" },
  { file: "template/caps/hardware/files/.agents/skills/muse-hardware/SKILL.md", line: "it stays private, so it has no files a board can fetch", why: "a trained model's files on the Hub" },
  { file: "template/caps/hardware/files/.agents/skills/muse-hardware/SKILL.md", line: 'never call that "stays on your device"', why: "the rule against this very claim" },
];

const HEADING = "## Who can read the text";
const TABLE_HEAD = ["| Path | Code | Tier | Who can read the text | What a product may say | Today (Nov 2) |", "|---|---|---|---|---|---|"];
const linesOf = (file: string) => readFileSync(file, "utf8").split(/\r?\n/);

/** Where the table's section starts and ends in docs/GADGETS.md. It names the private path, so it's held to REACH on its own. */
function sectionBounds(lines: string[]): [number, number] {
  const start = lines.indexOf(HEADING);
  assert.ok(start >= 0, `docs/GADGETS.md has no "${HEADING}"`);
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return [start, end < 0 ? lines.length : end];
}

function tableSection(): { rows: string[]; words: string } {
  const lines = linesOf("docs/GADGETS.md");
  const [start, end] = sectionBounds(lines);
  const section = lines.slice(start + 1, end);
  return { rows: section.filter((line) => line.startsWith("|")), words: section.filter((line) => !line.startsWith("|")).join(" ") };
}

const PRIVACY = REACH.find((row) => row.private)!;
const NOT_PRIVATE = REACH.filter((row) => !row.private);
const rowOf = (id: ReachRow["id"]) => REACH.find((row) => row.id === id)!;

const docRow = (row: ReachRow) =>
  `| ${row.name} | ${row.code.map((path) => `\`${path}\``).join(", ")} | ${row.tier} | ${row.whoCanRead} | ${row.sentence} | ${row.today} |`;

/** What a row has to name, so one can't pass by saying less. */
const MUST_NAME: Record<string, RegExp[]> = {
  "paired-board": [/product's server/, /Muse Muse/, /tunnel/, /photos and recordings/],
  "fleet-gateway": [/product's server/, /ngrok/, /Muse Muse/, /cloud provider/, /office network/, /Vercel/],
  "board-tools": [/product's server/, /Muse Muse/, /ngrok/, /lead board/, /plain http/, /photos and recordings/],
};
/** The private row's one way of saying the relay isn't end-to-end encrypted, so it can't come to say the opposite. */
const NOT_END_TO_END = "the relay isn't end-to-end encrypted";

describe("who can read the text", () => {
  it("is what the checks read", () => {
    for (const claim of ["It stays on your device.", "Runs on-device", "on device", "Your answers stay private", "privately", "Nothing leaves", "not only private"]) {
      assert.ok(claimsIn(claim).length > 0, claim);
    }
    for (const fine of ["Answers aren't private.", "Answers aren&apos;t private.", "This isn't private.", 'href="/private"', "Muse Privacy", "A device on the desk"]) {
      assert.deepEqual(claimsIn(fine), [], fine);
    }
    assert.deepEqual(wrappedClaimsIn("Your answers stay on your", "device."), ["stay on your device"]);
    assert.deepEqual(wrappedClaimsIn("// It stays on your", "// device."), ["stays on your device"]);
    assert.deepEqual(wrappedClaimsIn("Answers from a board aren't", "private."), []);
    assert.deepEqual(wrappedClaimsIn("It runs on-device,", "a device on the desk."), [], "a claim on one line is counted there, not twice");
  });

  it("has one private path, on a person's own laptop", () => {
    assert.deepEqual(REACH.filter((row) => row.private).map((row) => row.id), ["muse-privacy"]);
    assert.deepEqual(REACH.filter((row) => row.tier === "this-machine").map((row) => row.id), ["muse-privacy"]);
    assert.deepEqual(NOT_PRIVATE.map((row) => row.id), ["paired-board", "fleet-gateway", "board-tools"]);
    assert.match(PRIVACY.sentence, /laptop/);
    assert.match(PRIVACY.today, /never run on a board/);
  });

  it("says what leaves the laptop on the private path (privacy/docs/THREAT_MODEL.md, rows R and A2)", () => {
    for (const name of [/Cloudflare/, /Muse's requests/, /any name you type into Muse/, /can miss a name/]) assert.match(PRIVACY.sentence, name);
    for (const name of [/Cloudflare ends TLS/, /Muse's own requests/, /any name typed into Muse/, /only the names swapped/, /reaches Meta/]) {
      assert.match(PRIVACY.whoCanRead, name);
    }
    assert.ok(PRIVACY.whoCanRead.includes(NOT_END_TO_END), `it says "${NOT_END_TO_END}"`);
    for (const copy of [PRIVACY.whoCanRead.replace(NOT_END_TO_END, ""), PRIVACY.sentence, PRIVACY.today]) {
      assert.doesNotMatch(copy, /end-to-end/, "and nothing else about end-to-end encryption");
    }
  });

  it("gives every row a tier, code that exists and one sentence with no em dash", () => {
    for (const row of REACH) {
      assert.ok(["this-machine", "home", "shared"].includes(row.tier), row.id);
      assert.match(row.sentence, /^[^.!?]+\.$/, `${row.id} shows one sentence`);
      assert.ok(row.code.length > 0, row.id);
      for (const path of row.code.filter((p) => !p.startsWith("jetson-infra:"))) assert.ok(existsSync(path), path);
      assert.ok(!JSON.stringify(row).includes("—"), row.id);
    }
  });

  it("claims nothing for a path that isn't private, and names who can read it", () => {
    for (const row of NOT_PRIVATE) {
      for (const copy of [row.name, row.whoCanRead, row.sentence, row.today]) assert.deepEqual(claimsIn(copy), [], `${row.id}: ${copy}`);
      for (const name of MUST_NAME[row.id]!) assert.match(row.sentence, name, row.id);
      assert.notEqual(row.tier, "this-machine", row.id);
    }
    // One ngrok agent fronts the whole control plane on port 8080, /device included, and its inspector is on.
    for (const id of ["fleet-gateway", "board-tools"] as const) {
      assert.match(rowOf(id).whoCanRead, /port 4040.*in memory/, `${id}: ngrok's inspector can hold what passes, so the row can't say nothing keeps it`);
    }
    assert.match(rowOf("fleet-gateway").whoCanRead, /report, not reproduced/, "nobody here measured the 50 requests");
    assert.match(rowOf("board-tools").whoCanRead, /bearer token/);
    assert.match(rowOf("fleet-gateway").whoCanRead, /offlinebase\.com\/admin/, "the Vercel rewrite in front of ngrok");
    assert.match(rowOf("board-tools").whoCanRead, /admin page \/device \(\/api\/device\/ask\)/, "not the fleet's /device route");
    assert.ok(rowOf("board-tools").code.includes("app/api/device/ask/route.ts"), "the route that calls Meta");
  });

  it("finds no such claim in the gadget and fleet copy", () => {
    const found = COPY_FILES.flatMap((file) => {
      const allowed = ALLOWED.filter((entry) => entry.file === file);
      const lines = linesOf(file).map((line) => (allowed.some((entry) => line.includes(entry.line)) ? "" : line));
      if (file === "docs/GADGETS.md") lines.fill("", ...sectionBounds(lines));
      return lines.flatMap((line, i) => [
        ...claimsIn(line).map((claim) => `${file}:${i + 1}: ${claim}`),
        ...wrappedClaimsIn(line, lines[i + 1] ?? "").map((claim) => `${file}:${i + 1}-${i + 2}: ${claim}`),
      ]);
    });
    assert.deepEqual(found, []);
  });

  it("keeps each allowed line, and no allowance for a file it doesn't read", () => {
    for (const { file, line, why } of ALLOWED) {
      assert.ok(COPY_FILES.includes(file), file);
      assert.ok(readFileSync(file, "utf8").includes(line), `${file} no longer says "${line}", so drop it (${why})`);
    }
  });

  it("shows the same table in docs/GADGETS.md, and no other row", () => {
    const { rows } = tableSection();
    assert.deepEqual(rows.slice(0, 2), TABLE_HEAD);
    assert.deepEqual(rows.slice(2), REACH.map(docRow), "docs/GADGETS.md's rows differ from lib/inference/reach.ts");
  });

  it("claims no more in the words around the table", () => {
    const { words } = tableSection();
    const onlyPrivate = `${PRIVACY.name} is the only private path.`;
    assert.ok(words.includes(onlyPrivate), `docs/GADGETS.md no longer says "${onlyPrivate}"`);
    assert.deepEqual(claimsIn(words.replace(onlyPrivate, "")), []);
    assert.match(words, /`home` here means the owner's own board/, "OFFLINE.md's home is on the owner's LAN, so the stretch is said here");
  });

  it("carries the words the plain copy needs", () => {
    assert.match(readFileSync("components/private/PrivateBody.tsx", "utf8"), /Answers from the Jetson fleet or a paired board aren't private\./);
    assert.doesNotMatch(readFileSync("docs/SUBMISSION.md", "utf8"), /local or private model/);
  });

  it("rests on what the code still does", async () => {
    // The paired-board row: "over a public https address on a hosted site", a pin or not.
    const onTheLan = async () => ["192.168.1.20"];
    for (const url of ["https://192.168.1.20:8765/mcp", "https://jetson-02.local/mcp"]) {
      assert.equal((await checkBoardAddress(url, { hosted: true, pinned: true, lookup: onTheLan })).ok, false, `a hosted site calls ${url}`);
    }
    assert.equal((await checkBoardAddress("https://board.example.com/mcp", { hosted: true, pinned: true, lookup: async () => ["93.184.216.34"] })).ok, true);
    assert.match(readFileSync("lib/caps/hardware/flags.ts", "utf8"), /on\("GADGET_CONNECT"\)/, "off unless it's set");
    // Two rows' "today" cite this entry for production. The test can't read production, only that the citation still stands.
    assert.match(readFileSync("docs/BUILD_LOG.md", "utf8"), /`DEVICE_MCP_URL`, `DEVICE_MCP_TOKEN` and `GADGET_CONNECT` aren't set\./);
    assert.match(
      readFileSync("muse-device/autostart.sh", "utf8"),
      /^\s*\(cd "\$HERE" && exec setsid nohup python3 server\.py --host 0\.0\.0\.0 --port /m,
      "the line that starts the board's tools has them listen on the office network",
    );
  });

  it("is data, so it can't reach privacy/", () => {
    assert.doesNotMatch(readFileSync("lib/inference/reach.ts", "utf8"), /^\s*import\b|\bfrom\s+["'`]|\brequire\s*\(|\bimport\s*\(/m);
  });
});
