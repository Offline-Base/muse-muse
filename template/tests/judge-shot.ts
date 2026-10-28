// Platform file: don't edit. Take every judge screenshot with judgeShot(page, "02-result").
// It waits for work in progress to finish, checks the screen for problems a judge marks down (text cut off, a page
// or a box that scrolls sideways, a long headline, a wrapped choice, bar text that overlaps, em dashes, a button still
// saying it is working), then saves the full-page screenshot. In the demo video's runs it only waits and gives viewers
// a beat: verify already took the screenshots and checked the screen at phone size, so a demo never fails on a check
// that passed there.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
  const smoke = test.info().project.name === "smoke";
  // MUSEMUSE_SCREEN_CHECK=warn (set by the platform, never by the product) logs problems instead of failing.
  const problems = smoke ? await page.evaluate(findScreenProblems) : [];
  if (problems.length && process.env.MUSEMUSE_SCREEN_CHECK === "warn") {
    console.log(`musemuse screen check, ${name}: ${problems.join(" | ")}`);
  } else {
    expect(problems, `${name}: fix these in the product (a judge sees them), not in this check`).toEqual([]);
  }
  // Fine on an earlier screen, so only noted here: verify fails the run when the last screenshot has an error or empty
  // state, starts its result too far down, or is too long.
  const errorsAndEmpty = smoke ? await page.evaluate(findErrorsAndEmptyStates) : [];
  const { resultTop, pageHeight } = smoke ? await page.evaluate(measurePage) : { resultTop: null, pageHeight: null };
  // verify prints notes without failing.
  const notes = smoke && name.startsWith("01-") && hasSamples() ? await page.evaluate(findMissingSample) : [];
  mkdirSync("test-results/judge", { recursive: true });
  await page.screenshot({ path: `test-results/judge/${name}.png`, fullPage: true });
  writeFileSync(`test-results/judge/${name}.checked`, `${JSON.stringify({ problems, errorsAndEmpty, resultTop, pageHeight, notes })}\n`);
}

/** True when fixtures/ holds a sample, not just its README. */
function hasSamples(): boolean {
  try {
    return readdirSync("fixtures").some((f) => !f.startsWith(".") && !/^readme/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Runs in the browser. Where the result starts, in px from the top of the page: the first visible [data-result], or
 * without one the first visible .card.ai, or null when there is neither. And the full page's height.
 */
export function measurePage(): { resultTop: number | null; pageHeight: number } {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const first = (selector: string) => [...document.querySelectorAll(selector)].find(visible);
  const result = first("[data-result]") ?? first(".card.ai");
  return {
    resultTop: result ? Math.round(result.getBoundingClientRect().top + scrollY) : null,
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
  };
}

/** Runs in the browser. A note when the start screen has no visible button or link starting with "Try". */
export function findMissingSample(): string[] {
  const offered = [...document.querySelectorAll("button, a, [role='button']")].some((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && /^try\b/i.test((el as HTMLElement).innerText.trim());
  });
  return offered
    ? []
    : ['The start screen has no "Try the sample" button, though fixtures/ holds samples. Give it one that fills the input in one tap (product-ui, States).'];
}

/**
 * Runs in the browser. Each visible error, field marked invalid and empty state with text in it, as a short phrase,
 * at most 5. querySelectorAll doesn't look inside shadow roots, so Next's own route announcer (role="alert") never
 * counts.
 */
export function findErrorsAndEmptyStates(): string[] {
  const out: string[] = [];
  const found: Element[] = [];
  // In the full-page screenshot: shown, and not moved off the page's left or top edge for screen readers only.
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return false;
    return r.width > 2 && r.height > 2 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  // A field's words are its label (or its value); anything else's are its text.
  const words = (el: Element) => {
    let text = (el as HTMLElement).innerText;
    if (el.matches("input, select, textarea")) {
      const field = el as HTMLInputElement;
      const labelledBy = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "");
      text = [...(field.labels ?? [])].map((l) => l.innerText).join(" ") || labelledBy.join(" ").trim() || el.getAttribute("aria-label") || field.value;
    }
    return (text ?? "").trim().replace(/\s+/g, " ");
  };
  const kinds: Array<[string, string]> = [
    ['[role="alert"], .error', "an error"],
    ['[aria-invalid="true"]', "a field marked invalid"],
    [".empty", "an empty state"],
  ];
  for (const [selector, kind] of kinds) {
    for (const el of document.querySelectorAll(selector)) {
      if (found.some((f) => f.contains(el) || el.contains(f)) || !visible(el)) continue;
      const text = words(el);
      if (!text) continue;
      found.push(el);
      out.push(`${kind}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);
    }
  }
  return out.slice(0, 5);
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

  // A headline longer than two lines.
  for (const h of document.querySelectorAll("h1")) {
    if (!visible(h)) continue;
    const style = getComputedStyle(h);
    const lines = Math.round(h.getBoundingClientRect().height / (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2));
    if (lines > 2) out.push(`The headline takes ${lines} lines: ${describe(h)}. Say what the screen does in a few words, 2 lines at most (meta-ui).`);
  }

  // Choices in a segmented control that wrap inside their pill or run out of it.
  for (const group of document.querySelectorAll(".segmented")) {
    const bad: string[] = [];
    for (const label of group.querySelectorAll("label")) {
      if (!visible(label)) continue;
      const tops = new Set<number>();
      const range = document.createRange();
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top));
      }
      if (tops.size > 1 || label.scrollWidth > label.clientWidth + 1) bad.push(`"${(label as HTMLElement).innerText.trim().replace(/\s+/g, " ")}"`);
    }
    if (bad.length) out.push(`Choices wrap or run out of their pills: ${bad.slice(0, 3).join(", ")}. Give each a word or two, which <Segmented> lays out to fit, or use a select.`);
  }

  // Text under a chart's bars that runs into the text of the next bar with any.
  for (const chart of document.querySelectorAll(".bars")) {
    if (!visible(chart)) continue;
    const bad: string[] = [];
    let last: { right: number; text: string } | null = null;
    for (const bar of chart.querySelectorAll(":scope > .bar")) {
      const range = document.createRange();
      range.selectNodeContents(bar);
      const r = range.getBoundingClientRect();
      const text = (bar as HTMLElement).innerText.trim().replace(/\s+/g, " ");
      if (r.width < 1 || !text) continue;
      if (last && r.left < last.right - 1) bad.push(`"${last.text}" and "${text}"`);
      last = { right: r.right, text };
    }
    if (bad.length) {
      out.push(
        `Bar text runs into the next bar's: ${bad.slice(0, 2).join(", ")}. From 9 bars keep each line under a bar to about ` +
          "4 characters (Jan, 1.2k, W12), and past 12 write the text on every other bar only (meta-ui components.md).",
      );
    }
  }

  // A box that scrolls sideways on a phone hides what is past its edge. Code blocks and fields may scroll.
  if (vw <= 480) {
    for (const el of document.body.querySelectorAll("*")) {
      if (el.matches("pre, pre *, textarea, input, select") || el.closest("[data-allow-clip]")) continue;
      if (!/auto|scroll/.test(getComputedStyle(el).overflowX) || el.scrollWidth <= el.clientWidth + 1 || !visible(el)) continue;
      out.push(
        `A box scrolls sideways, hiding ${el.scrollWidth - el.clientWidth}px of ${describe(el)}. Fit it to the phone (3 table columns at most, ` +
          "editable rows in .rows, 16 bars with short text at most), or mark it data-allow-clip when scrolling is the point, like a spreadsheet's grid.",
      );
    }
  }

  const controls = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A", "LABEL"]);
  for (const el of document.body.querySelectorAll("*")) {
    if (out.length >= 10) break;
    if (!(controls.has(el.tagName) || ownText(el)) || !visible(el)) continue;
    if (el.closest("[data-allow-clip]")) continue;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // Shortened with an ellipsis or a line clamp. The person's own words (data-user-text) may be.
    const clamped = !!style.webkitLineClamp && style.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 1;
    const ellipsis = style.overflowX !== "visible" && style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1;
    if (ownText(el) && (clamped || ellipsis) && !el.closest("[data-user-text]")) {
      out.push(`Text is shortened with "...": ${describe(el)}. Let it wrap instead.`);
      continue;
    }
    // A one-line field that hides part of its value, or of its placeholder while it is empty. The placeholder is
    // measured as the value for a moment, without events, then the field is emptied again.
    if (el instanceof HTMLInputElement && /^(text|search|email|url|)$/.test(el.type) && (el.value || el.placeholder)) {
      const empty = !el.value;
      if (empty) el.value = el.placeholder;
      const cut = el.scrollWidth > el.clientWidth + 1;
      if (empty) el.value = "";
      if (cut) {
        out.push(
          empty
            ? `A one-line field cuts off its placeholder: ${describe(el)}. Shorten it to a few words.`
            : `A one-line field cuts off its value: ${describe(el)}. Use a textarea or a wider field.`,
        );
        continue;
      }
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
