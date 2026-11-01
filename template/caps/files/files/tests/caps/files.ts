// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
//   openAsOwner(page)         makes this browser the product's owner (a build's tests only). Any other browser is a
//                             visitor, as on the live product.
//   checkFiles(page, {...})   the platform's check of kept files, once per smoke test:
//     upload                  a fixture's path, put in the page's file input (data-testid="file-upload")
//     listed                  text the page shows for the kept file, such as its name. Expected again after a reload,
//                             then the judge screenshot "10-after-reload"
//     search                  { q, expect }: typed into the page's search box (data-testid="file-search") and sent with
//                             Enter; `expect` must show with a Citation (data-citation) on screen
//     dataset                 { shows }: text the page shows from a vetted dataset, with its Citation
//                             (data-citation="dataset", which shows the license)
//   The search and dataset steps end on the judge screenshot "11-file-sources".
//
// Every file a build keeps is a real file in its own test space on the gateway, deleted when the build ends.
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { judgeShot } from "../judge-shot";
import { recordCapCheck } from "./index";

/**
 * The owner pass a build's tests use. The gateway takes it only from a build's own token, so it means nothing on the
 * live product, where only Muse Muse's "Open as owner" makes someone the owner.
 */
const BUILD_TEST_OWNER = "ot1.build-test-owner";

/** Makes this page's browser the product's owner (a build's tests only), through the product's own mm_owner cookie. */
export async function openAsOwner(page: Page): Promise<void> {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("openAsOwner needs the test's baseURL.");
  await page.context().addCookies([{ name: "mm_owner", value: BUILD_TEST_OWNER, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

export interface FilesCheck {
  /** A fixture to upload, relative to the product's folder, like "fixtures/notes.txt". */
  upload: string;
  /** Text the page shows for the kept file, such as its name. */
  listed: string;
  search?: { q: string; expect: string };
  dataset?: { shows: string };
  /** The page to open. "/" by default. */
  path?: string;
}

async function checked(id: string, okDetail: string, shot: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    recordCapCheck("files", { id, ok: true, detail: okDetail, shot: `${shot}.png` });
  } catch (err) {
    recordCapCheck("files", { id, ok: false, detail: `${okDetail}: no. ${String((err as Error)?.message ?? err).split("\n")[0]}`.slice(0, 280) });
    throw err;
  }
}

/** The platform's check of kept files. Call it once, on a page where the person can upload. */
export async function checkFiles(page: Page, check: FilesCheck): Promise<void> {
  await page.goto(check.path ?? "/");
  await checked("upload-listed", "An uploaded file is still listed after a reload", "10-after-reload", async () => {
    await page.getByTestId("file-upload").setInputFiles(path.resolve(check.upload));
    await expect(page.getByText(check.listed, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await expect(page.getByText(check.listed, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  });
  await judgeShot(page, "10-after-reload");
  if (check.search) {
    const { q, expect: shows } = check.search;
    await checked("search-cited", "A search for a phrase in the file found it and showed where it came from", "11-file-sources", async () => {
      const box = page.getByTestId("file-search");
      await box.fill(q);
      await box.press("Enter");
      await expect(page.getByText(shows, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.locator("[data-citation]").first()).toBeVisible({ timeout: 10_000 });
    });
  }
  if (check.dataset) {
    const shows = check.dataset.shows;
    await checked("dataset-cited", "Data from a vetted dataset shows with its source and license", "11-file-sources", async () => {
      await expect(page.getByText(shows, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-citation="dataset"]').first()).toBeVisible({ timeout: 10_000 });
    });
  }
  if (check.search || check.dataset) await judgeShot(page, "11-file-sources");
}
