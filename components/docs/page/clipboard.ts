/**
 * Clipboard writes for the docs (code blocks, Copy page, Copy prompt). Accepts text that is still loading: Safari
 * drops the user's click if the page awaits a fetch before writing, so a pending value goes through ClipboardItem,
 * which takes a promise and keeps the gesture. Falls back to a hidden textarea on browsers without the async API.
 */
export async function copyText(text: string | Promise<string>): Promise<boolean> {
  try {
    if (typeof text !== "string" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    }
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    try {
      const value = await text;
      const el = document.createElement("textarea");
      el.value = value;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      el.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
