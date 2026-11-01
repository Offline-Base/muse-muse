// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
//   signInAs(page, "Ana")              signs a made-up person in on this browser (a build's tests only)
//   openAsOwner(page)                  makes this browser the product's owner, for owner items and lists only the
//                                     owner writes (a build's tests only). Any other browser is a visitor, as live.
//   secondBrowser(page, async (other) => { ... })   runs steps in a second browser with its own cookies
//   checkSecondBrowser(page, { shared, private, loaded, user })
//                                     the platform's check: a second browser, after a reload, sees the shared item,
//                                     doesn't see the private one once the page has loaded its items (the shared item,
//                                     or the `loaded` text, shows that), and sees the user item once the same made-up
//                                     person signs in. Takes the judge screenshot "09-second-browser" and records it.
//   seed("collection", [{...}])        saves shared items as the owner, before the test opens the page
//
// Every item a build saves is a real row in its own test space on the gateway, deleted when the build ends.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { judgeShot } from "../judge-shot";
import { recordCapCheck } from "./index";

/** Signs a made-up person in on this page's browser, through the product's own sign-in route. */
export async function signInAs(page: Page, name: string): Promise<{ id: string; name: string }> {
  const res = await page.request.post("/api/musemuse/user", { data: { test: name } });
  const reply = (await res.json().catch(() => ({}))) as { user?: { id: string; name: string }; error?: string };
  if (!res.ok() || !reply.user) throw new Error(`signInAs("${name}") failed: ${reply.error ?? `HTTP ${res.status()}`}`);
  return reply.user;
}

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

/** Runs `fn` in a second browser with its own cookies, the way another person would open the product. */
export async function secondBrowser<T>(page: Page, fn: (other: Page) => Promise<T>): Promise<T> {
  const browser = page.context().browser();
  if (!browser) throw new Error("secondBrowser needs the test's own browser.");
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), viewport: page.viewportSize() ?? { width: 390, height: 844 } });
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close();
  }
}

export interface SecondBrowserCheck {
  /** Text of a shared item the first browser saved. The second browser must see it. */
  shared?: string;
  /** Text of a visitor or user item the first browser saved. The second browser must not see it. */
  private?: string;
  /**
   * Text the page shows once it has loaded its items, such as an empty list's message. With `private` and no `shared`,
   * the check waits for it, so it can't pass before the items arrive.
   */
  loaded?: string;
  /** A user item: the same made-up person signs in on the second browser and must see `text`. */
  user?: { name: string; text: string };
  /** The page to open. "/" by default. */
  path?: string;
}

async function checked(cap: string, id: string, okDetail: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    recordCapCheck(cap, { id, ok: true, detail: okDetail, shot: "09-second-browser.png" });
  } catch (err) {
    recordCapCheck(cap, { id, ok: false, detail: `${okDetail}: no. ${String((err as Error)?.message ?? err).split("\n")[0]}`.slice(0, 280) });
    throw err;
  }
}

/** The platform's check of saved data across two browsers. Call it once, after the first browser saved its items. */
export async function checkSecondBrowser(page: Page, check: SecondBrowserCheck): Promise<void> {
  if (!check.shared && !check.private && !check.user) throw new Error("checkSecondBrowser needs a shared, private or user item to look for.");
  await secondBrowser(page, async (other) => {
    await other.goto(check.path ?? "/");
    await other.reload();
    await other.waitForLoadState("networkidle").catch(() => undefined);
    if (check.shared) {
      await checked("data", "second-browser", "Second browser, after a reload, sees the shared item", () => expect(other.getByText(check.shared!, { exact: false }).first()).toBeVisible({ timeout: 30_000 }));
    }
    if (check.private) {
      await checked("data", "visitor-private", "Second browser, after a reload, doesn't see the private item", async () => {
        // Not seeing it proves nothing until the page has its items: the shared item above, or the loaded text, says so.
        if (!check.shared && !check.loaded) throw new Error("give checkSecondBrowser a shared item or the loaded text, so it knows the page has its items");
        if (check.loaded) await expect(other.getByText(check.loaded, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
        await expect(other.getByText(check.private!, { exact: false })).toHaveCount(0, { timeout: 10_000 });
      });
    }
    await judgeShot(other, "09-second-browser");
    if (check.user) {
      await signInAs(other, check.user.name);
      await other.reload();
      await checked("data", "user-follows", "The same person, signed in on the second browser, sees their item", () => expect(other.getByText(check.user!.text, { exact: false }).first()).toBeVisible({ timeout: 30_000 }));
    }
  });
}

function gatewaySettings(): { base: string; token: string } {
  let base = process.env.GATEWAY_URL;
  let token = process.env.PRODUCT_TOKEN;
  if (!base || !token) {
    try {
      for (const line of readFileSync(".env.local", "utf8").split("\n")) {
        const [k, ...v] = line.split("=");
        if (k === "GATEWAY_URL" && !base) base = v.join("=").trim();
        if (k === "PRODUCT_TOKEN" && !token) token = v.join("=").trim();
      }
    } catch {
      // No .env.local: the error below says what's missing.
    }
  }
  if (!base || !token) throw new Error("seed needs GATEWAY_URL and PRODUCT_TOKEN, which the platform writes into .env.local for a build.");
  return { base: base.replace(/\/+$/, ""), token };
}

/** Saves shared items as the owner (a build's own call names no one else), before the test opens the page. */
export async function seed(collection: string, docs: Array<Record<string, unknown>>): Promise<string[]> {
  const { base, token } = gatewaySettings();
  const ids: string[] = [];
  for (const doc of docs.slice(0, 20)) {
    const res = await fetch(`${base}/data/${collection}?scope=shared`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ data: doc }),
    });
    const reply = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok || !reply.id) throw new Error(`seed("${collection}") failed: ${reply.error?.message ?? `HTTP ${res.status}`}`);
    ids.push(reply.id);
  }
  return ids;
}
