import type { FnToolDef } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";

/**
 * cookbook/perception-error-screenshot-fix on our error screenshot (public/docs-samples/error-screenshot.png): the
 * Plantwise Shop checkout crashes with "TypeError: Cannot read properties of undefined (reading 'map')" at
 * components/CartItems.tsx 14:27, called from app/checkout/page.tsx 22. This is the small Next.js repo behind it, with
 * the same bug class in more places, so the fix-scope question is real: guard one call site (minimal) or make the cart
 * loader always return items (global). Line numbers match the screenshot.
 *
 * The second screenshot (lib/cart-shot.ts, drawn in the page) is the same bug on another surface, the way the
 * recipe's second instance is: the cart page with an empty cart, where OrderSummary's cart.items.reduce throws and
 * SummaryBoundary shows "We couldn't total your order." It names no file, so the model finds the code from the
 * visible text, which is why every string on it appears in these files.
 */

export const SHOP_FILES: Record<string, string> = {
  "package.json": '{\n  "name": "plantwise-shop",\n  "private": true,\n  "scripts": { "dev": "next dev", "test": "vitest run" }\n}\n',
  "lib/cart.ts": `export interface CartItem {
  id: string;
  name: string;
  quantity: number;
  priceCents: number;
}

export interface Cart {
  id: string;
  items: CartItem[];
}

/** Loads the visitor's cart from the API. */
export async function fetchCart(): Promise<Cart> {
  const res = await fetch("/api/cart", { cache: "no-store" });
  if (!res.ok) throw new Error(\`cart \${res.status}\`);
  return res.json();
}
`,
  "app/api/cart/route.ts": `import { getCartFor } from "@/lib/db";

// The API leaves "items" out for a visitor who hasn't added anything yet.
export async function GET(request: Request) {
  const cart = await getCartFor(request);
  if (!cart || cart.items.length === 0) return Response.json({ id: cart?.id ?? "new" });
  return Response.json(cart);
}
`,
  "components/CartItems.tsx": `"use client";

// The cart lines on the checkout page: one row per item, with its quantity.
// Rendered by CheckoutPage once the cart has loaded.

import type { Cart } from "@/lib/cart";

// Keep this list simple: quantity changes happen on the cart page,
// so checkout only shows what is in the cart.
// See components/OrderSummary.tsx for the totals.

export function CartItems({ cart }: { cart: Cart }) {
  return (
    <ul>{cart.items.map((item) => (
      <li key={item.id}>{item.name} x {item.quantity}</li>
    ))}</ul>
  );
}
`,
  "components/OrderSummary.tsx": `import type { Cart } from "@/lib/cart";

export function OrderSummary({ cart }: { cart: Cart }) {
  const total = cart.items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  return (
    <aside className="summary">
      <h2>Order summary</h2>
      <p className="total">Total: \${(total / 100).toFixed(2)}</p>
    </aside>
  );
}
`,
  "components/SummaryBoundary.tsx": `"use client";

import { Component, type ReactNode } from "react";

// Keeps a broken order summary from taking the whole cart page down.

export class SummaryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <aside className="summary">
        <h2>Order summary</h2>
        <p className="error">{"We couldn't total your order."}</p>
        <p>Refresh the page or try again in a moment.</p>
        <button onClick={() => this.setState({ failed: false })}>Try again</button>
      </aside>
    );
  }
}
`,
  "app/cart/page.tsx": `"use client";

import { useEffect, useState } from "react";
import { CartItems } from "@/components/CartItems";
import { OrderSummary } from "@/components/OrderSummary";
import { SummaryBoundary } from "@/components/SummaryBoundary";
import { fetchCart, type Cart } from "@/lib/cart";

// The cart page: the lines on the left, the order summary beside them.

export default function CartPage() {
  const [cart, setCart] = useState<Cart | null>(null);

  useEffect(() => {
    fetchCart().then(setCart);
  }, []);

  if (!cart) return <p>Loading...</p>;
  return (
    <main className="cart">
      <h1>Your cart</h1>
      {cart.items?.length ? (
        <CartItems cart={cart} />
      ) : (
        <section className="empty">
          <h2>Your cart is empty</h2>
          <p>Plants you add show up here.</p>
          <a href="/shop">Browse plants</a>
        </section>
      )}
      <SummaryBoundary>
        <OrderSummary cart={cart} />
      </SummaryBoundary>
    </main>
  );
}
`,
  "components/CartBadge.tsx": `import type { Cart } from "@/lib/cart";

export function CartBadge({ cart }: { cart: Cart }) {
  return <span className="badge">{cart.items.length}</span>;
}
`,
  "app/checkout/page.tsx": `"use client";

import { useEffect, useState } from "react";
import { CartItems } from "@/components/CartItems";
import { OrderSummary } from "@/components/OrderSummary";
import { fetchCart, type Cart } from "@/lib/cart";

// Checkout: the cart lines, the total, and the pay button.
// The cart loads on mount; until then the page shows a spinner.
// Payment itself lives in app/checkout/pay.ts.

export default function CheckoutPage() {
  const [cart, setCart] = useState<Cart | null>(null);

  useEffect(() => {
    fetchCart().then(setCart);
  }, []);

  if (!cart) return <p>Loading...</p>;
  return (
    <main>
      <CartItems cart={cart} />
      <OrderSummary cart={cart} />
      <button type="submit">Pay</button>
    </main>
  );
}
`,
  "app/layout.tsx": `import { CartBadge } from "@/components/CartBadge";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <a href="/" className="brand">Plantwise</a>
          <nav>
            <a href="/shop">Shop</a>
            <a href="/guides">Guides</a>
            <a href="/cart">Cart</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
`,
  "lib/db.ts": `import type { Cart } from "@/lib/cart";

const carts = new Map<string, Cart>();

export async function getCartFor(request: Request): Promise<Cart | null> {
  const id = request.headers.get("x-visitor") ?? "";
  return carts.get(id) ?? null;
}
`,
  "README.md": "# Plantwise Shop\n\nA small Next.js shop. `npm run dev` serves it at localhost:3000.\n",
};

export const QUESTION_TOOL: FnToolDef = {
  name: "question",
  description: "Ask the developer a multiple-choice question before you commit to a plan, such as the fix scope. Returns the option they pick.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, description: { type: "string" } },
          required: ["label", "description"],
          additionalProperties: false,
        },
      },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
};

export const PLAN_SYSTEM = `You are OpenCode's Plan agent working in the developer's repository (a Next.js shop). You can read and search files and ask the developer questions; you cannot edit anything.
Look at the attached screenshot(s) first and say what they show before you open any source file. Use the visible text (error message, file names, line numbers, headings, URL) to find the code.
Find the root cause, not just the line that threw. Check for the same pattern elsewhere before proposing a fix.
Before you commit to a fix shape, call the question tool with the scope choice (for example minimal targeted fix vs global preventive fix) and what each option changes.
End with a short plan: the root cause with file:line, and the exact edits you will make.`;

export const BUILD_SYSTEM = `You are OpenCode's Build agent. Apply the plan the developer approved, with the edit tool (oldString must match exactly once; read the file first) or write for new files.
Make the smallest edits that implement the plan. When done, list the files you changed and how the developer should verify the fix in the browser.`;

export const PLAN_PROMPT = "i am encountering this error at checkout (see the screenshot). figure out what needs to change here and come up with a plan";

/** The recipe's two-screenshot prompt, for the checkout crash plus the cart page. */
export const PLAN_PROMPT_TWO =
  "i am encountering an issue (see the second screenshot) where the order summary on my cart page won't load. a similar crash was reported at checkout (see the first screenshot). both happen when the cart is empty. figure out what needs to change here and come up with a plan";

export const SMOKE_PROMPT = "what's in this screenshot?";

export interface Surface {
  path: string;
  line: number;
  text: string;
  guarded: boolean;
}

/**
 * Every place that reads cart.items, and whether it's safe now: guarded at the call site (?. or ??), or covered
 * because fetchCart always returns items. The recipe's "which other surfaces to spot-check" list.
 */
export function cartSurfaces(files: Record<string, string>): { surfaces: Surface[]; loaderNormalizes: boolean; apiAlwaysItems: boolean } {
  const loader = files["lib/cart.ts"] ?? "";
  const loaderNormalizes = /items\s*:\s*[^,}\n]*\?\?\s*\[\]|items\s*\?\?=|Array\.isArray\([^)]*items|items:\s*\[\]\s*,?\s*\.\.\./.test(loader) || /items\s*\|\|\s*\[\]/.test(loader);
  const api = files["app/api/cart/route.ts"] ?? "";
  const apiAlwaysItems = !/Response\.json\(\{\s*id:[^}]*\}\s*\)/.test(api) || /items:\s*\[\]/.test(api);
  const surfaces: Surface[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/\.(tsx?|jsx?)$/.test(path) || path.startsWith("app/api/") || path === "lib/cart.ts" || path === "lib/db.ts") continue;
    text.split("\n").forEach((line, i) => {
      if (!/cart\??\.items/.test(line)) return;
      const local = /cart\??\.items\s*\?\.|cart\??\.items\s*\?\?|\(cart\??\.items\s*\?\?\s*\[\]\)|cart\??\.items\s*\|\|/.test(line);
      surfaces.push({ path, line: i + 1, text: line.trim(), guarded: local || loaderNormalizes || apiAlwaysItems });
    });
  }
  return { surfaces: surfaces.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line), loaderNormalizes, apiAlwaysItems };
}
