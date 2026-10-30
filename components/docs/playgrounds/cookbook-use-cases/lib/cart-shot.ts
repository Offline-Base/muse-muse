/**
 * The error-screenshot-fix demo's second screenshot, drawn in the browser: the Plantwise Shop cart page in a
 * production build, where an empty cart breaks the order summary and its error boundary shows a fallback. Unlike the
 * first sample (a dev overlay that prints components/CartItems.tsx 14:27), it shows only what a visitor sees: no file
 * names, no stack. The model has to find the code from the visible text ("Order summary", "We couldn't total your
 * order."), the way the recipe greps a dialog title and a heading, and the two screenshots together point at the
 * shared root cause (the cart API leaves out items for an empty cart). Every string on it is in SHOP_FILES.
 */

export const CART_SHOT = { width: 1280, height: 800, name: "cart-page.png" } as const;

/** What the page itself shows, each string as it appears in the repo's source. */
export const CART_SHOT_UI = {
  heading: "Your cart",
  empty: "Your cart is empty",
  emptyHint: "Plants you add show up here.",
  browse: "Browse plants",
  summary: "Order summary",
  failed: "We couldn't total your order.",
  failedHint: "Refresh the page or try again in a moment.",
  retry: "Try again",
} as const;

/** The browser chrome around it. */
export const CART_SHOT_CHROME = { tab: "Your cart | Plantwise Shop", url: "localhost:3000/cart", brand: "Plantwise", nav: ["Shop", "Guides", "Cart"] } as const;

export const CART_SHOT_ALT =
  'The Plantwise Shop cart page at localhost:3000/cart: "Your cart is empty" on the left, and an "Order summary" card on the right that says "We couldn\'t total your order." with a Try again button. No error text or file names.';

/** The 2D context calls the drawing uses, so a test can record them. */
export type DrawContext = Pick<
  CanvasRenderingContext2D,
  "fillStyle" | "strokeStyle" | "lineWidth" | "font" | "textAlign" | "textBaseline" | "fillRect" | "strokeRect" | "beginPath" | "moveTo" | "lineTo" | "arc" | "arcTo" | "closePath" | "fill" | "stroke" | "fillText"
>;

const FONT = "Helvetica, Arial, sans-serif";

function box(ctx: DrawContext, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function label(ctx: DrawContext, text: string, x: number, y: number, size: number, color: string, weight = 400, align: CanvasTextAlign = "left") {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
}

/** Draws the cart page at 1280 x 800, in the same browser frame as the error-screenshot sample. */
export function drawCartShot(ctx: DrawContext): void {
  const { width: W, height: H } = CART_SHOT;
  // Browser chrome: a tab strip and the address bar.
  ctx.fillStyle = "#e8e9ed";
  ctx.fillRect(0, 0, W, 40);
  box(ctx, 12, 6, 240, 40, 8);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  label(ctx, CART_SHOT_CHROME.tab, 28, 29, 13, "#3c4043");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 40, W, 44);
  [
    ["#ff5f57", 20],
    ["#febc2e", 44],
    ["#28c840", 68],
  ].forEach(([color, x]) => {
    ctx.beginPath();
    ctx.arc(Number(x), 62, 6, 0, Math.PI * 2);
    ctx.fillStyle = String(color);
    ctx.fill();
  });
  box(ctx, 88, 47, 1178, 30, 15);
  ctx.fillStyle = "#f1f3f4";
  ctx.fill();
  label(ctx, CART_SHOT_CHROME.url, 104, 67, 14, "#202124");
  ctx.fillStyle = "#dadce0";
  ctx.fillRect(0, 84, W, 1);

  // The page.
  ctx.fillStyle = "#fafaf7";
  ctx.fillRect(0, 85, W, H - 85);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 85, W, 64);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillRect(0, 149, W, 1);
  ctx.beginPath();
  ctx.arc(76, 117, 11, 0, Math.PI * 2);
  ctx.fillStyle = "#2f6b3a";
  ctx.fill();
  label(ctx, CART_SHOT_CHROME.brand, 96, 125, 22, "#1f3d25", 700);
  CART_SHOT_CHROME.nav.forEach((item, i) => label(ctx, item, 1010 + i * 80, 123, 15, i === 2 ? "#1f3d25" : "#4b5563", i === 2 ? 700 : 400));

  label(ctx, CART_SHOT_UI.heading, 64, 212, 32, "#111827", 700);

  // The cart itself: empty, and that part of the page handles it.
  box(ctx, 64, 244, 680, 300, 14);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(404, 330, 34, 0, Math.PI * 2);
  ctx.fillStyle = "#eef5ef";
  ctx.fill();
  ctx.strokeStyle = "#2f6b3a";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(388, 322);
  ctx.lineTo(392, 344);
  ctx.lineTo(418, 344);
  ctx.lineTo(422, 322);
  ctx.closePath();
  ctx.stroke();
  label(ctx, CART_SHOT_UI.empty, 404, 408, 22, "#111827", 700, "center");
  label(ctx, CART_SHOT_UI.emptyHint, 404, 438, 15, "#6b7280", 400, "center");
  box(ctx, 328, 466, 152, 42, 21);
  ctx.strokeStyle = "#2f6b3a";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  label(ctx, CART_SHOT_UI.browse, 404, 493, 15, "#2f6b3a", 700, "center");

  // The order summary: its error boundary's fallback.
  box(ctx, 776, 244, 440, 300, 14);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  ctx.stroke();
  label(ctx, CART_SHOT_UI.summary, 804, 288, 19, "#111827", 700);
  ctx.fillStyle = "#e5e7eb";
  ctx.fillRect(804, 306, 384, 1);
  ctx.beginPath();
  ctx.arc(826, 352, 14, 0, Math.PI * 2);
  ctx.fillStyle = "#fde8e7";
  ctx.fill();
  label(ctx, "!", 826, 358, 17, "#b42318", 700, "center");
  label(ctx, CART_SHOT_UI.failed, 852, 358, 16, "#b42318", 700);
  label(ctx, CART_SHOT_UI.failedHint, 852, 384, 14, "#6b7280");
  box(ctx, 804, 472, 384, 44, 10);
  ctx.fillStyle = "#1f3d25";
  ctx.fill();
  label(ctx, CART_SHOT_UI.retry, 996, 500, 15, "#ffffff", 700, "center");
}
