// Pure render checks: renderFixPrompt, renderRefinePrompt and briefToMarkdown on the saved photo brief. No API calls.
import type { Brief } from "@/lib/brief/schema";
import { briefToMarkdown, renderFixPrompt, renderRefinePrompt } from "@/lib/brief/render";
import { loadJson } from "./brief-common";

const saved = loadJson<{ brief: Brief }>("brief-photo");
if (!saved) throw new Error("Run scripts/dev/brief-photo.ts first");

const fix = renderFixPrompt({
  round: 2,
  verify: {
    passed: false,
    steps: [
      { name: "typecheck", ok: true, ms: 8123 },
      { name: "build", ok: true, ms: 30412 },
      { name: "start", ok: true, ms: 1800 },
      { name: "console", ok: true, ms: 900 },
      { name: "smoke", ok: false, ms: 91000, detail: "1 failed: primary flow works with the sample photo" },
      { name: "manifest", ok: true, ms: 40 },
    ],
    failureOutput: "Error: expect(locator).toBeVisible() failed\nLocator: getByText(/birds found/i)\n```\nnested fence\n```\nTimeout 90000ms",
  },
  judge: { pass: false, reasons: ["Final screen shows a spinner."], mismatches: ["Show the total count on the final screen."] },
});
console.log(fix);
console.log("CHECK fix fence survives nested backticks:", fix.includes("````text") ? "ok" : "FAIL");

console.log(renderFixPrompt({ round: 1, verify: { passed: true, steps: [], failureOutput: "" }, judge: { pass: false, reasons: ["Shows a logo from the inspo."], mismatches: [] } }));

console.log(
  renderRefinePrompt({
    message: "Add a dark mode\nand let me name each bird",
    newReferences: [{ fileName: "dark-sketch.png", describes: "A hand sketch of the result screen on a dark background." }],
  }),
);
const md = briefToMarkdown(saved.brief);
console.log(md);
const all = fix + md;
console.log("CHECK no em dashes:", all.includes("—") ? "FAIL" : "ok");
