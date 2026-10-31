// Platform file: don't edit. Lines only a screen reader sees, which mirror what the scene is doing. Tests assert on them,
// since they can't read a canvas.
const CLIP = "position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";

function line(attribute: string, role: string): HTMLElement {
  let el = document.querySelector<HTMLElement>(`[${attribute}]`);
  if (!el) {
    el = document.createElement("p");
    el.setAttribute("role", role);
    el.setAttribute(attribute, "");
    el.style.cssText = CLIP;
    document.body.appendChild(el);
  }
  return el;
}

/** What the scene shows now, like "Selected Start". With `busy`, judge screenshots wait until the next call clears it. */
export function setXRStatus(text: string, busy = false): void {
  const el = line("data-xr-status", "status");
  el.textContent = text;
  if (busy) el.setAttribute("aria-busy", "true");
  else el.removeAttribute("aria-busy");
}

/** Something went wrong in the scene. Verify fails when the last VR screenshot has one, so clear it with null once fixed. */
export function setXRAlert(text: string | null): void {
  line("data-xr-alert", "alert").textContent = text ?? "";
}

/** The status line's text, or an empty string before the first call. */
export function xrStatusText(): string {
  return document.querySelector("[data-xr-status]")?.textContent ?? "";
}
