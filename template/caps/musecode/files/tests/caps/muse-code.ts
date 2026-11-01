// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
//   expectMuseCodeRun(page)     after the test started ONE real Muse Code task through the product's own page (made-up
//                               data, never replay): waits for the run screen (CodeRun) to end, then checks it shows
//                               files and the final answer, a download, and the cost. Takes the judge screenshot
//                               "08-muse-code-run" and records the check. A run that ended without files fails it:
//                               "worked" means files, not the exit code.
//   expectReplayRun(page)       the same screen for a replay run (`replay: true`), which spends nothing. Use it for
//                               every other test. It records nothing for the fixed checks.
//
// The gateway's own record must also show the real task made files (verify's caps step). At most 2 real tasks in a
// whole build, 5 minutes and $0.50 in all.
import { expect, type Page } from "@playwright/test";
import { judgeShot } from "../judge-shot";
import { recordCapCheck } from "./index";

const ENDED = /^(completed|failed|stopped|expired)$/;

async function ended(page: Page, timeoutMs: number) {
  const run = page.locator('[data-musecode="run"]').last();
  await expect(run).toBeVisible();
  await expect(run).toHaveAttribute("data-musecode-status", ENDED, { timeout: timeoutMs });
  return run;
}

/** One real task's run screen ended with files, the final answer, a download and the cost. */
export async function expectMuseCodeRun(page: Page, opts: { timeoutMs?: number } = {}): Promise<void> {
  const detail = "A real Muse Code task ran and its files and final answer show";
  try {
    const run = await ended(page, opts.timeoutMs ?? 5 * 60_000);
    await expect(run).toHaveAttribute("data-musecode-replay", "false");
    await expect(run.locator('[data-musecode="final"]')).not.toBeEmpty();
    await expect(run.locator('[data-musecode="files"] code').first()).toBeVisible();
    await expect(run.locator('[data-musecode="download"]')).toBeVisible();
    await expect(run.locator('[data-musecode="cost"]')).toBeVisible();
    await expect(page.locator('[data-musecode="disclosure"]').first()).toBeVisible();
    await judgeShot(page, "08-muse-code-run");
    recordCapCheck("code", { id: "muse-code-run", ok: true, detail, shot: "08-muse-code-run.png" });
  } catch (err) {
    recordCapCheck("code", { id: "muse-code-run", ok: false, detail: `${detail}: no. ${String((err as Error)?.message ?? err).split("\n")[0]}`.slice(0, 280) });
    throw err;
  }
}

/** A replay run's screen ended and shows the recorded steps, files and answer. Spends nothing. */
export async function expectReplayRun(page: Page, opts: { timeoutMs?: number } = {}): Promise<void> {
  const run = await ended(page, opts.timeoutMs ?? 30_000);
  await expect(run).toHaveAttribute("data-musecode-replay", "true");
  await expect(run.locator('[data-musecode="steps"] li').first()).toBeVisible();
  await expect(run.locator('[data-musecode="final"]')).not.toBeEmpty();
  await expect(run.locator('[data-musecode="files"] code').first()).toBeVisible();
}
