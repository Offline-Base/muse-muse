// Platform file: don't edit. Take every judge screenshot with judgeShot(page, "02-result").
// It waits for work in progress to finish, checks the screen for problems a judge marks down (text cut off, a page
// that scrolls sideways, em dashes, a button still saying it is working), then saves the full-page screenshot.
// In the demo video's runs it only waits and gives viewers a beat: verify already took the screenshots and checked the
// screen at phone size, so a demo never fails on a check that passed there.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/** The demo video's runs: Playwright's own video (demo) and Demo Studio's recorder (studio). */
const DEMO_PROJECTS = new Set(["demo", "studio"]);

export async function judgeShot(page: Page, name: string): Promise<void> {
  if (!/^\d\d-[a-z0-9-]+$/.test(name)) throw new Error(`judgeShot name "${name}" must look like "02-result".`);
  await expect(page.locator('[aria-busy="true"]'), `${name}: something is still marked aria-busy="true"`).toHaveCount(0, {
    timeout: 90_000,
  });
  if (DEMO_PROJECTS.has(test.info().project.name)) {
    await page.waitForTimeout(600);
    return;
  }
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(250);
  // MUSEMUSE_SCREEN_CHECK=warn (set by the platform, never by the product) logs problems instead of failing.
  const problems = test.info().project.name === "smoke" ? await page.evaluate(findScreenProblems) : [];
  if (problems.length && process.env.MUSEMUSE_SCREEN_CHECK === "warn") {
    console.log(`musemuse screen check, ${name}: ${problems.join(" | ")}`);
  } else {
    expect(problems, `${name}: fix these in the product (a judge sees them), not in this check`).toEqual([]);
  }
  mkdirSync("test-results/judge", { recursive: true });
  await page.screenshot({ path: `test-results/judge/${name}.png`, fullPage: true });
  writeFileSync(`test-results/judge/${name}.checked`, `${JSON.stringify({ problems })}\n`);
}

/** Runs in the browser. Returns plain sentences, at most 10. */
export function findScreenProblems(): string[] {
  const out: string[] = [];
  const vw = document.documentElement.clientWidth;
  const describe = (el: Element) => {
    const h = el as HTMLElement & { placeholder?: string; value?: string };
    const text = (h.innerText || h.value || h.getAttribute("aria-label") || h.placeholder || "").trim().replace(/\s+/g, " ");
    return `<${el.tagName.toLowerCase()}> "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`;
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const ownText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());

  const pageWidth = document.documentElement.scrollWidth;
  if (pageWidth > vw + 1) out.push(`The page scrolls sideways: it is ${pageWidth}px wide on a ${vw}px screen.`);

  const controls = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A", "LABEL"]);
  for (const el of document.body.querySelectorAll("*")) {
    if (out.length >= 10) break;
    if (!(controls.has(el.tagName) || ownText(el)) || !visible(el)) continue;
    if (el.closest("[data-allow-clip]")) continue;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // Shortened with an ellipsis or a line clamp.
    if (ownText(el) && style.overflowX !== "visible" && style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) {
      out.push(`Text is shortened with "...": ${describe(el)}. Let it wrap instead.`);
      continue;
    }
    // A one-line field that hides part of its value.
    if (el instanceof HTMLInputElement && /^(text|search|email|url|)$/.test(el.type) && el.value && el.scrollWidth > el.clientWidth + 1) {
      out.push(`A one-line field cuts off its value: ${describe(el)}. Use a textarea or a wider field.`);
      continue;
    }
    // A text box that hides part of its text and can't grow.
    if (el instanceof HTMLTextAreaElement && el.value && el.scrollHeight > el.clientHeight + 2) {
      const sizing = (style as CSSStyleDeclaration & { fieldSizing?: string }).fieldSizing;
      if (sizing !== "content") out.push(`A text box hides part of its text: ${describe(el)}. Keep the template's textarea style so it grows.`);
      continue;
    }
    // Cut off by the nearest box that clips (a scroll container is fine).
    let box = el.parentElement;
    while (box && box !== document.body && getComputedStyle(box).overflowX === "visible" && getComputedStyle(box).overflowY === "visible") {
      box = box.parentElement;
    }
    if (box && box !== document.body) {
      const bs = getComputedStyle(box);
      const br = box.getBoundingClientRect();
      if (br.width <= 2 || br.height <= 2 || /auto|scroll/.test(bs.overflowX)) continue;
      if (r.right > br.right + 1 || r.left < br.left - 1) out.push(`Cut off at the side of its box: ${describe(el)}.`);
    } else if (r.right > vw + 1) {
      out.push(`Runs off the right edge of the screen: ${describe(el)}.`);
    }
  }

  // Still working.
  for (const b of document.querySelectorAll("button:disabled, [aria-disabled='true']")) {
    const t = (b.textContent ?? "").trim();
    if (visible(b) && /(…|\.\.\.)$/.test(t)) out.push(`A button still says it is working: "${t}". Wait for the result before the screenshot.`);
  }
  for (const p of document.querySelectorAll("progress:not([value]), [role='progressbar']:not([aria-valuenow])")) {
    if (visible(p)) out.push("A loading indicator is still showing. Wait for the result before the screenshot.");
  }

  // Em dashes in visible copy, except text the user typed or uploaded (mark it with data-user-text) and code.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const dashes: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || !n.textContent?.includes("\u2014") || parent.closest("[data-user-text], code, pre, script, style")) continue;
    if (visible(parent)) dashes.push(n.textContent.trim().slice(0, 50));
  }
  for (const f of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
    if (f.closest("[data-user-text]") || !visible(f)) continue;
    if (`${f.placeholder ?? ""}${f.value ?? ""}`.includes("\u2014")) dashes.push(`${describe(f)} placeholder or value`);
  }
  if (dashes.length) out.push(`Em dashes in the copy (use a comma, colon or period): ${dashes.slice(0, 3).map((d) => `"${d}"`).join(", ")}.`);

  return out.slice(0, 10);
}
