// Platform file: don't edit. Take every judge screenshot with judgeShot(page, "02-result").
// It waits for work in progress to finish, checks the screen for problems a judge marks down (text cut off, a page
// or a box that scrolls sideways, a long headline, a wrapped choice, bar text that overlaps, em dashes, a button still
// saying it is working, a control too small to tap on a phone, text too faint to read on its background), then saves
// the full-page screenshot. In the demo video's runs it only waits and gives viewers a beat: verify already took the
// screenshots and checked the screen at phone size, so a demo never fails on a check that passed there. In a VR product a shot taken inside VR has its own check (tests/xr.ts): the view must keep drawing
// and not be blank, and the 2D layout checks don't apply.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  if (isVRProduct()) {
    // Only a VR product loads the headset's helpers, so every other product's test runs just as it did.
    const { inVRSession, xrJudgeShot } = await import("./xr");
    if (await inVRSession(page)) return xrJudgeShot(page, name);
  }
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(250);
  const smoke = test.info().project.name === "smoke";
  // MUSEMUSE_SCREEN_CHECK=warn (set by the platform, never by the product) logs problems instead of failing.
  const problems = smoke
    ? [
        ...(await page.evaluate(findScreenProblems)),
        ...tapTargetProblems(await page.evaluate(collectTapTargets)),
        ...contrastProblems(await page.evaluate(collectTextSamples)),
      ]
    : [];
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

/** True when musemuse.target.json lists vr. A product without that file is a web product. */
function isVRProduct(): boolean {
  try {
    const { targets } = JSON.parse(readFileSync("musemuse.target.json", "utf8")) as { targets?: unknown };
    return Array.isArray(targets) && targets.includes("vr");
  } catch {
    return false;
  }
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

// ---------- Tap targets and contrast. The browser gathers what is on screen; the rules after it are plain functions. ----------

/** A control on screen as the tap target check reads it. */
export type TapSample = {
  /** Its accessible name, shortened. */
  name: string;
  tag: string;
  width: number;
  height: number;
  /** A link set inline inside a sentence, which may be as tall as its line. */
  inText: boolean;
  /**
   * How many controls of its exact size sit packed in rows and columns with it, counting itself: the cells of a board,
   * a keypad or a calendar. 1 when it isn't in such a grid.
   */
  dense: number;
};

/** The smallest a control may be on a phone, in CSS px, both ways. */
export const TAP_MIN = 44;
/** This many same-size controls packed in rows and columns are a board, a keypad or a calendar, whose cells may be smaller. */
export const DENSE_GRID = 12;

/**
 * Runs in the browser. Every visible, enabled control, at phone size only: buttons, links, fields, selects, summaries
 * and ARIA controls. A checkbox, radio or file input counts as the label around it, which is what a finger presses
 * (Segmented's pills, FilePicker's dropzone, a checkbox row). Empty on a wider screen.
 */
export function collectTapTargets(): TapSample[] {
  if (document.documentElement.clientWidth > 480) return [];
  const CONTROLS =
    'button, a[href], select, summary, input:not([type="hidden"]), [role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"]';
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const clean = (t: string | null | undefined) => (t ?? "").trim().replace(/\s+/g, " ");
  const nameOf = (el: Element) => {
    const field = el as HTMLInputElement;
    const labelledBy = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "");
    const name =
      clean(el.getAttribute("aria-label")) ||
      clean(labelledBy.join(" ")) ||
      clean((el as HTMLElement).innerText) ||
      clean([...(field.labels ?? [])].map((l) => l.innerText).join(" ")) ||
      clean(el.getAttribute("title")) ||
      clean(el.querySelector("img[alt]")?.getAttribute("alt")) ||
      clean(field.placeholder) ||
      clean(field.value);
    return name.length > 30 ? `${name.slice(0, 30)}...` : name;
  };
  // The box a run of text flows in: the nearest ancestor that isn't inline.
  const blockOf = (start: Element | null) => {
    let n = start;
    while (n && n !== document.body && /^(inline|contents)$/.test(getComputedStyle(n).display)) n = n.parentElement;
    return n;
  };
  // A link inside a sentence: shown inline, with words on its lines that belong to no other control. Model text
  // (.prose) is all sentences.
  const inRunningText = (el: Element) => {
    if (!el.matches('a[href], [role="link"]') || getComputedStyle(el).display !== "inline") return false;
    if (el.closest(".prose")) return true;
    const block = blockOf(el.parentElement);
    if (!block) return false;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent || !/\p{L}{2,}|\p{N}/u.test(n.textContent ?? "") || parent.closest(CONTROLS)) continue;
      if (blockOf(parent) === block) return true;
    }
    return false;
  };
  const out: TapSample[] = [];
  const seen = new Set<Element>();
  for (const found of document.body.querySelectorAll(CONTROLS)) {
    if (found.closest('[inert], [aria-hidden="true"]') || found.matches(':disabled, [aria-disabled="true"]')) continue;
    const label = found.matches('input[type="checkbox"], input[type="radio"], input[type="file"]')
      ? (found.closest("label") ?? (found as HTMLInputElement).labels?.[0])
      : null;
    const el: Element = label ?? found;
    if (seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    const sameSize = (other: Element) => {
      const o = other.getBoundingClientRect();
      return Math.abs(o.width - r.width) <= 1 && Math.abs(o.height - r.height) <= 1;
    };
    // A board: 12 or more controls of this size in its parent or up to two levels above it (a cell may sit in its own
    // <td> or <div>), lined up in at least 2 rows and 2 columns that fill a lattice, each next to the last. Dots
    // scattered on a photo and a column of row buttons aren't one.
    let dense = 1;
    for (let box = el.parentElement, up = 0; box && box !== document.body && up < 3 && dense === 1; box = box.parentElement, up++) {
      const cells = [...box.querySelectorAll(CONTROLS)].filter((c) => c === el || (sameSize(c) && visible(c))).map((c) => c.getBoundingClientRect());
      if (cells.length < 12) continue; // DENSE_GRID, which a page can't reach
      const packed = (edges: number[], size: number) => {
        const sorted = [...new Set(edges.map(Math.round))].sort((a, b) => a - b);
        return sorted.length >= 2 && sorted.every((v, i) => i === 0 || v - sorted[i - 1] <= size + 8) ? sorted.length : 0;
      };
      const cols = packed(cells.map((c) => c.left), r.width);
      const rows = packed(cells.map((c) => c.top), r.height);
      if (cols && rows && cols * rows <= cells.length * 1.5) dense = cells.length;
    }
    out.push({
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      width: Math.round(r.width * 10) / 10,
      height: Math.round(r.height * 10) / 10,
      inText: inRunningText(el),
      dense,
    });
  }
  return out;
}

/** True when a control is under TAP_MIN either way, and isn't a link in a sentence or a cell of a dense grid. */
export function isSmallTarget(s: TapSample): boolean {
  if (s.inText || s.dense >= DENSE_GRID) return false;
  return s.width < TAP_MIN - 0.5 || s.height < TAP_MIN - 0.5;
}

/** One sentence naming up to 4 controls too small to tap, or nothing. */
export function tapTargetProblems(samples: TapSample[]): string[] {
  const small = samples.filter(isSmallTarget);
  if (!small.length) return [];
  const listed = small.slice(0, 4).map((s) => `<${s.tag}> "${s.name}" ${Math.round(s.width)}x${Math.round(s.height)}`);
  const more = small.length > 4 ? ` and ${small.length - 4} more` : "";
  return [
    `Too small to tap on a phone (under ${TAP_MIN}x${TAP_MIN} px): ${listed.join(", ")}${more}. Make every button, link that ` +
      `stands on its own, field and checkbox row at least ${TAP_MIN} px tall and wide. A small icon, dot or pin can keep its ` +
      `look inside a ${TAP_MIN} px box (padding plus background-clip: content-box). A link inside a sentence is fine ` +
      "(product-ui, Accessibility).",
  ];
}

/** A run of text as the contrast check reads it. Colors are CSS rgb() or rgba() strings. */
export type TextSample = {
  text: string;
  color: string;
  /** Background colors from the text's own element outward, ending at the first solid one. */
  layers: string[];
  /** Font size in CSS px, and weight. */
  size: number;
  weight: number;
  /**
   * Why the page's colors can't tell what is behind the text, so the check leaves it out: "image" (a background image
   * or gradient), "media" (over a photo, video, canvas or drawing), "faded" (opacity, a filter or a blend mode),
   * "floating" (on see-through glass, positioned over something else, or overlapping a positioned fill such as a
   * hero's overlay), "no-ground" (no solid background at all).
   */
  skip?: "image" | "media" | "faded" | "floating" | "no-ground";
};

/**
 * Runs in the browser. Every visible element with text of its own: its text color and the backgrounds behind it, up
 * to the nearest solid one. Text in an SVG, in a disabled control or in a select is left out.
 */
export function collectTextSamples(): TextSample[] {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  // Any CSS color (oklch, a named color) as rgba(), read back from a one-pixel canvas. rgb() and rgba() pass as they are.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const read = new Map<string, string>();
  const norm = (css: string) => {
    if (/^rgba?\(/.test(css) || !ctx) return css;
    let hit = read.get(css);
    if (hit === undefined) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0, 0, 0, 0)";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      hit = `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
      read.set(css, hit);
    }
    return hit;
  };
  // rgb(r, g, b) is solid; rgba(r, g, b, a) and rgb(r g b / a%) carry a fourth number.
  const alphaOf = (c: string) => {
    const nums = c.match(/[\d.]+%?/g) ?? [];
    if (nums.length < 4) return 1;
    const a = nums[3];
    return a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
  };
  const fades = (s: CSSStyleDeclaration) => Number(s.opacity) < 1 || s.filter !== "none" || s.mixBlendMode !== "normal";
  // Photos, video, canvases and drawings, at least 40 px each way for a drawing (an icon beside a label isn't one).
  const media = [...document.querySelectorAll("img, video, canvas, iframe, object, embed, svg")].filter((m) => {
    if (m.matches("svg") && m.parentElement?.closest("svg")) return false;
    const r = m.getBoundingClientRect();
    return visible(m) && (!m.matches("svg") || (r.width >= 40 && r.height >= 40));
  });
  // Fills laid over other content: a positioned element with a fill, or a positioned ::before or ::after with a fill
  // that covers most of its element (a hero's dark overlay). Text they overlap may sit on them, not on its own ground.
  const painted = (s: CSSStyleDeclaration) => s.backgroundImage !== "none" || alphaOf(norm(s.backgroundColor)) > 0;
  const positioned = (s: CSSStyleDeclaration) => /^(absolute|fixed)$/.test(s.position);
  const overlays: { box: Element; pseudo: boolean }[] = [];
  for (const o of document.body.querySelectorAll("*")) {
    if (o.closest("svg")) continue;
    const s = getComputedStyle(o);
    if (s.display === "none") continue;
    if (positioned(s) && painted(s) && visible(o)) overlays.push({ box: o, pseudo: false });
    const r = o.getBoundingClientRect();
    const cover = ["::before", "::after"].some((at) => {
      const p = getComputedStyle(o, at);
      if (/^(none|normal)$/.test(p.content) || !positioned(p) || !painted(p)) return false;
      return parseFloat(p.width) * parseFloat(p.height) >= 0.5 * r.width * r.height;
    });
    if (cover && r.width > 2 && r.height > 2) overlays.push({ box: o, pseudo: true });
  }
  const out: TextSample[] = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (out.length >= 2000) break;
    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
    if (!own.length || el.closest("svg, script, style, noscript, template, select")) continue;
    if (el.closest(':disabled, [aria-disabled="true"], label:has(input:disabled)') || !visible(el)) continue;
    const range = document.createRange();
    const rects: DOMRect[] = [];
    for (const n of own) {
      range.selectNodeContents(n);
      rects.push(...[...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
    }
    if (!rects.length) continue;
    const text = own.map((n) => n.textContent).join(" ").trim().replace(/\s+/g, " ");
    const style = getComputedStyle(el);
    const sample: TextSample = {
      text: text.length > 40 ? `${text.slice(0, 40)}...` : text,
      color: norm(style.color),
      layers: [],
      size: parseFloat(style.fontSize),
      weight: Number(style.fontWeight) || 400,
    };
    let ground: Element | null = null;
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = n === el ? style : getComputedStyle(n);
      if (fades(s)) {
        sample.skip = "faded";
        break;
      }
      if (s.display === "contents") continue;
      if (s.backgroundImage !== "none") {
        sample.skip = "image";
        break;
      }
      const bg = norm(s.backgroundColor);
      const a = alphaOf(bg);
      const glass = a > 0 && a < 1 && (/^(fixed|sticky)$/.test(s.position) || (s.backdropFilter || "none") !== "none");
      if (glass || (a < 1 && /^(absolute|fixed)$/.test(s.position))) {
        sample.skip = "floating";
        break;
      }
      if (a > 0) sample.layers.push(bg);
      if (a >= 1) {
        ground = n;
        break;
      }
    }
    if (!sample.skip && !ground) sample.skip = "no-ground";
    // Fading something above the ground fades the text and its background together, over whatever is behind them.
    for (let n = ground?.parentElement ?? null; n && !sample.skip; n = n.parentElement) if (fades(getComputedStyle(n))) sample.skip = "faded";
    // A photo or drawing inside the ground that overlaps the text is behind it.
    if (!sample.skip && ground) {
      const page = ground === document.documentElement || ground === document.body;
      for (const m of media) {
        if (!page && !ground.contains(m)) continue;
        const mr = m.getBoundingClientRect();
        if (rects.some((r) => r.left < mr.right && r.right > mr.left && r.top < mr.bottom && r.bottom > mr.top)) {
          sample.skip = "media";
          break;
        }
      }
      // A positioned fill inside the ground that overlaps the text, other than one the text sits in, may be under it.
      for (const { box, pseudo } of overlays) {
        if (sample.skip || (!page && !ground.contains(box)) || (!pseudo && box.contains(el))) continue;
        const or = box.getBoundingClientRect();
        if (rects.some((r) => r.left < or.right && r.right > or.left && r.top < or.bottom && r.bottom > or.top)) sample.skip = "floating";
      }
    }
    out.push(sample);
  }
  return out;
}

/** [r, g, b, a] from "rgb(1, 2, 3)", "rgba(1, 2, 3, 0.5)" or "rgb(1 2 3 / 50%)", or null when it isn't one of those. */
export function parseRgb(css: string): [number, number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(css.trim());
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Math.min(1, Math.max(0, alpha))];
}

/** Paints `top`, which may be see-through, over a solid `bottom`. */
export function paintOver(top: readonly number[], bottom: readonly number[]): number[] {
  const a = top[3] ?? 1;
  return [0, 1, 2].map((k) => top[k] * a + bottom[k] * (1 - a)).concat(1);
}

/** WCAG relative luminance of a solid [r, g, b]. */
export function luminance(rgb: readonly number[]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio of two solid colors, from 1 to 21. */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG's large text, which needs 3:1 instead of 4.5:1: 24 px, or 18.66 px (14 pt) and bold. */
export function isLargeText(size: number, weight: number): boolean {
  return size >= 24 || (size >= 18.66 && weight >= 700);
}

/** A sample's contrast ratio with what is behind it, or null when the check leaves it out. */
export function sampleContrast(s: TextSample): number | null {
  if (s.skip || !s.layers.length) return null;
  const color = parseRgb(s.color);
  const layers = s.layers.map(parseRgb);
  if (!color || color[3] === 0 || layers.some((l) => l === null)) return null;
  const solid = layers as number[][];
  if (solid[solid.length - 1][3] < 1) return null;
  // Paint from the solid ground outward in, then the text over the result.
  const ground = solid.reduceRight<number[]>((under, layer) => paintOver(layer, under), solid[solid.length - 1]);
  return contrastRatio(paintOver(color, ground), ground);
}

/** One sentence naming up to 3 runs of text under WCAG AA on what is behind them, or nothing. */
export function contrastProblems(samples: TextSample[]): string[] {
  const bad = new Map<string, string>();
  for (const s of samples) {
    const ratio = sampleContrast(s);
    if (ratio === null || bad.has(s.text)) continue;
    const need = isLargeText(s.size, s.weight) ? 3 : 4.5;
    // A hair of slack for colors rounded on their way out of the browser.
    if (ratio < need - 0.02) bad.set(s.text, `"${s.text}" ${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`);
  }
  if (!bad.size) return [];
  const listed = [...bad.values()];
  const more = listed.length > 3 ? ` and ${listed.length - 3} more` : "";
  return [
    `Text too faint to read on what is behind it: ${listed.slice(0, 3).join(", ")}${more}. Text needs 4.5:1, or 3:1 from 24 px ` +
      "(18.66 px bold). When you change a part's background, change its text color with it, in light and dark mode: the " +
      "person's chat bubble takes --bubble-out and --on-bubble-out together, never a new background alone (product-ui, Accessibility).",
  ];
}
