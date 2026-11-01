// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
//   const fx = codeFixture("python")     the platform's fixture program, with the exact stdout it must print. Its
//                                        numbers change every run, so only a real run gives the right answer.
//   expectInPageRun(page, fx)            after the test ran fx.code through the product's own editor in the browser
//                                        (Pyodide for python, QuickJS for javascript): the page ran it there and shows
//                                        fx.stdout. Takes the judge screenshot "08-code-output" and records the check.
//   expectExecOutput(page, fx)           after the test ran fx.code through the product's own server route
//                                        (runOnServer): the page shows fx.stdout. Takes "08-server-output". The gateway's
//                                        own record must also show the run.
//   expectBrowsePage(page)               after the test opened a page through the product's own route (openPage): the
//                                        page shows the sample page's text. Takes "08-sample-page".
//
// Run fx.code by typing or pasting it into the product's editor, the way a person would, never by calling a helper
// from the test. At most 3 server runs and 1 page per smoke test.
import { expect, type Page } from "@playwright/test";
import { judgeShot } from "../judge-shot";
import { recordCapCheck } from "./index";

export interface CodeFixture {
  language: "python" | "javascript" | "node";
  code: string;
  /** Exactly what the program prints. */
  stdout: string;
}

/** The marker every recorded sample page's text carries (lib/caps/code/pages on the platform). */
export const SAMPLE_PAGE_MARKER = /mm-sample-page-\d+/;

function nonce(): number {
  return 1000 + Math.floor(Math.random() * 9000);
}

/** A small program whose output depends on numbers picked now: the sum of 0 to n - 1, and n squared. */
export function codeFixture(language: CodeFixture["language"]): CodeFixture {
  const n = nonce();
  const stdout = `mm-fixture ${(n * (n - 1)) / 2} ${n * n}`;
  if (language === "python") return { language, code: `n = ${n}\nprint("mm-fixture", sum(range(n)), n * n)\n`, stdout };
  const js = `const n = ${n};\nlet total = 0;\nfor (let i = 0; i < n; i++) total += i;\nconsole.log("mm-fixture", total, n * n);\n`;
  return { language, code: js, stdout };
}

async function recorded(id: string, okDetail: string, shot: string, check: () => Promise<void>, page: Page): Promise<void> {
  try {
    await check();
    await judgeShot(page, shot);
    recordCapCheck("code", { id, ok: true, detail: okDetail, shot: `${shot}.png` });
  } catch (err) {
    recordCapCheck("code", { id, ok: false, detail: `${okDetail}: no. ${String((err as Error)?.message ?? err).split("\n")[0]}`.slice(0, 280) });
    throw err;
  }
}

/** The page ran the fixture in the browser and shows its exact output. */
export async function expectInPageRun(page: Page, fx: CodeFixture): Promise<void> {
  const runtime = fx.language === "python" ? "pyodide" : "quickjs";
  await recorded(
    "in-page",
    `${runtime === "pyodide" ? "Python" : "JavaScript"} ran in the page and its output shows`,
    "08-code-output",
    async () => {
      await expect(page.getByText(fx.stdout).first()).toBeVisible({ timeout: 90_000 });
      const notes = await page.evaluate(() => window.__musemuseCode ?? null);
      if (!notes || !(notes[runtime] > 0)) throw new Error(`the page didn't run anything with ${runtime}`);
      if (!notes.last || notes.last.runtime !== runtime || !notes.last.stdout.includes(fx.stdout)) throw new Error(`the last ${runtime} run didn't print the fixture's output`);
    },
    page,
  );
}

/** The page shows the exact output of the fixture the product ran on the platform. */
export async function expectExecOutput(page: Page, fx: CodeFixture): Promise<void> {
  await recorded(
    "exec-output",
    "The program ran on Muse Muse and its output shows",
    "08-server-output",
    async () => {
      await expect(page.getByText(fx.stdout).first()).toBeVisible({ timeout: 60_000 });
    },
    page,
  );
}

/** The page shows the recorded sample page a build's openPage returns. */
export async function expectBrowsePage(page: Page): Promise<void> {
  await recorded(
    "browse-page",
    "The opened page's text shows",
    "08-sample-page",
    async () => {
      await expect(page.getByText(SAMPLE_PAGE_MARKER).first()).toBeVisible({ timeout: 60_000 });
    },
    page,
  );
}
