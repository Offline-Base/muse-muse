// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
//   openAsOwner(page)                 makes this browser the product's owner (a build's tests only), for key settings
//                                    and sends, which only the owner may use
//   checkFetchShown(page, (fetched) => text)
//                                    the platform's check of a public API: `fetched` is what this server really got
//                                    (by "<api>.<path id>", like fetched["nws.forecast"]); pick text from it that the
//                                    page shows. Takes the judge screenshot "10-outside-data" and records the check
//   saveTestKey(page, "github")      types a made-up key into <KeySettings /> and saves it, then keeps the page so
//                                    verify can check that no page or file shows the key
//   confirmSend(page)                presses Confirm on <ConfirmSend /> and waits for "Sent (sample)". Takes the judge
//                                    screenshot "11-sent-sample" and records the check
//
// In a build every outside answer is a recorded sample, and a confirmed send goes nowhere.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { judgeShot } from "../judge-shot";
import { recordCapCheck } from "./index";

const CAP = "connect";
const BUILD_TEST_OWNER = "ot1.build-test-owner";

/** Makes this page's browser the product's owner (a build's tests only), through the product's own mm_owner cookie. */
export async function openAsOwner(page: Page): Promise<void> {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("openAsOwner needs the test's baseURL.");
  await page.context().addCookies([{ name: "mm_owner", value: BUILD_TEST_OWNER, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

async function checked(id: string, okDetail: string, shot: string | undefined, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    recordCapCheck(CAP, { id, ok: true, detail: okDetail, ...(shot ? { shot: `${shot}.png` } : {}) });
  } catch (err) {
    recordCapCheck(CAP, { id, ok: false, detail: `${okDetail}: no. ${String((err as Error)?.message ?? err).split("\n")[0]}`.slice(0, 280) });
    throw err;
  }
}

/** What this product's server got from public APIs in this run, by "<api>.<path id>". */
export function fetchedSamples(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), "test-results", "caps", "connect-fetched.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The platform's check of a public API: the page shows text from what the server really got. */
export async function checkFetchShown(page: Page, pick: (fetched: Record<string, any>) => string | number | null | undefined): Promise<void> {
  await checked("fetch-shown", "The page shows what the public API gave", "10-outside-data", async () => {
    const fetched = fetchedSamples();
    if (!Object.keys(fetched).length) throw new Error("the server made no public API call in this run");
    const text = pick(fetched);
    if (text === null || text === undefined || String(text).trim().length < 2) throw new Error("pick gave no text to look for");
    await expect(page.getByText(String(text).trim().slice(0, 120), { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await judgeShot(page, "10-outside-data");
  });
}

let pages = 0;

function keepPage(html: string): void {
  const dir = path.join(process.cwd(), "test-results", "caps", "connect-pages");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${++pages}.html`), html);
}

/**
 * Saves a made-up key for `service` through <KeySettings /> on the page already open, as the owner. The key is random
 * and never written anywhere by this helper: verify looks for it in the pages kept here and the build's files.
 */
export async function saveTestKey(page: Page, service: string): Promise<void> {
  await checked("key-saved", `The owner saved a ${service} key`, undefined, async () => {
    const key = `mmtest_${randomBytes(18).toString("base64url").replace(/[^A-Za-z0-9]/g, "x").slice(0, 24)}`;
    await page.getByTestId(`key-input-${service}`).fill(key);
    await page.getByTestId(`key-save-${service}`).click();
    await expect(page.getByTestId("key-status")).toHaveText("Saved.", { timeout: 30_000 });
    keepPage(await page.content());
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    keepPage(await page.content());
  });
}

/** Presses Confirm on the confirmation card and waits for the sample send to finish. */
export async function confirmSend(page: Page): Promise<void> {
  await checked("send-confirmed", "The owner confirmed one message, and it shows as sent", "11-sent-sample", async () => {
    await expect(page.getByTestId("confirm-send-card")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("confirm-send").click();
    await expect(page.getByTestId("send-result")).toHaveText("Sent (sample)", { timeout: 30_000 });
    keepPage(await page.content());
    await judgeShot(page, "11-sent-sample");
  });
}
