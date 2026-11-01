// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
// useFakeDevices puts a simulated port on the page, and checkDeviceLink runs one link session against it: the simulated
// port must get bytes from the product, and the product must show the reply. checkBoardTool runs one board tool through
// the product, and verify's caps step then asks the gateway's own record whether it reached the simulated board.
import { expect, type Page } from "@playwright/test";
import { judgeShot } from "../judge-shot";
import { installFakeDevices, type FakeDevicesConfig, type FakeDevicesRecord } from "./hardware-fake";
import { recordCapCheck } from "./index";

/** Call before page.goto. `reply` is what the device answers; pick something your product shows, like "TEMP 21.4". */
export async function useFakeDevices(page: Page, config: FakeDevicesConfig): Promise<void> {
  await page.addInitScript(installFakeDevices, config);
}

const fakeRecord = (page: Page) => page.evaluate(() => (globalThis as unknown as { __musemuseFakeDevices?: FakeDevicesRecord }).__musemuseFakeDevices ?? null);

export interface DeviceLinkCheck {
  link: "serial" | "usb" | "bluetooth";
  /** Clicks the product's connect button. */
  connect(page: Page): Promise<void>;
  /** Does what makes the product send something. */
  exchange(page: Page): Promise<void>;
  /** The reply as the product shows it. */
  shows: string | RegExp;
  /** A judge screenshot to take, like "02-reading". */
  shot?: string;
}

/** One link session. Records "link-sent" and "link-reply". */
export async function checkDeviceLink(page: Page, check: DeviceLinkCheck): Promise<void> {
  await check.connect(page);
  await expect.poll(async () => (await fakeRecord(page))?.connected.includes(check.link) ?? false, { message: `the product didn't connect over ${check.link}`, timeout: 15_000 }).toBe(true);
  await check.exchange(page);
  let sent = 0;
  await expect
    .poll(
      async () => {
        sent = ((await fakeRecord(page))?.sent ?? []).filter((s) => s.link === check.link && s.bytes.length > 0).length;
        return sent > 0;
      },
      { message: "the simulated device got nothing from the product", timeout: 15_000 },
    )
    .toBe(true)
    .catch(() => undefined);
  recordCapCheck("hardware", { id: "link-sent", ok: sent > 0, detail: sent > 0 ? `The simulated ${check.link} device got bytes from the product` : `The simulated ${check.link} device got nothing from the product` });
  expect(sent, "the simulated device got nothing from the product").toBeGreaterThan(0);
  const ok = await page.getByText(check.shows).first().waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
  if (check.shot) await judgeShot(page, check.shot);
  recordCapCheck("hardware", { id: "link-reply", ok, detail: ok ? "The product showed the device's reply" : "The product didn't show the device's reply", ...(check.shot ? { shot: `${check.shot}.png` } : {}) });
  expect(ok, "the product didn't show the device's reply").toBeTruthy();
}

export interface BoardToolCheck {
  /** Does what makes the product's server call readSensor or showText. */
  run(page: Page): Promise<void>;
  /** What the product shows from the answer. */
  shows: string | RegExp;
  shot?: string;
}

/** One board tool call through the product. Records "board-shown"; the gateway's record decides whether it reached the board. */
export interface DriveExportCheck {
  /** Does what makes the product ask, up to its confirmation card. */
  start(page: Page): Promise<void>;
  /** Presses confirm on the card. */
  confirm(page: Page): Promise<void>;
  /** What the product shows once the export is done. The simulated one takes about 8 seconds. */
  shows: string | RegExp;
  shot?: string;
}

/** One export through the product's card. Records "drive-shown". verify asks the gateway's own record whether it started. */
export async function checkDriveExport(page: Page, check: DriveExportCheck): Promise<void> {
  await check.start(page);
  await check.confirm(page);
  const ok = await page.getByText(check.shows).first().waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false);
  if (check.shot) await judgeShot(page, check.shot);
  recordCapCheck("hardware", { id: "drive-shown", ok, detail: ok ? "The product showed the finished export" : "The product didn't show the finished export", ...(check.shot ? { shot: `${check.shot}.png` } : {}) });
  expect(ok, "the product didn't show the finished export").toBeTruthy();
}

export async function checkBoardTool(page: Page, check: BoardToolCheck): Promise<void> {
  await check.run(page);
  const ok = await page.getByText(check.shows).first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
  if (check.shot) await judgeShot(page, check.shot);
  recordCapCheck("hardware", { id: "board-shown", ok, detail: ok ? "The product showed the board's answer" : "The product didn't show the board's answer", ...(check.shot ? { shot: `${check.shot}.png` } : {}) });
  expect(ok, "the product didn't show the board's answer").toBeTruthy();
}
