/**
 * The platform's sidebar rows (components/shell/nav.ts): which rows there are, in what order, which one each path
 * lights, and that NavLinks, which the desktop sidebar and the phone menu both render through ShellNav, marks it.
 *
 *   npx tsx --test --experimental-test-module-mocks components/shell/__tests__/nav.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement } from "react";
import {
  HELP_ITEMS,
  NAV_GROUPS,
  SECTION_TABS,
  START_MUSING,
  USAGE_ITEM,
  currentTab,
  isActive,
  isDocsPath,
  isHelpPath,
  type NavItem,
} from "@/components/shell/nav";

const canMock = typeof (mock as { module?: unknown }).module === "function";

/** Every sidebar row and button, top to bottom. */
const ALL: NavItem[] = [START_MUSING, ...NAV_GROUPS.flat(), USAGE_ITEM];

/** The row a path lights, by label, or null. Exactly one row may light up. */
function activeLabel(pathname: string): string | null {
  const lit = ALL.filter((item) => isActive(item, pathname));
  assert.ok(lit.length <= 1, `${pathname} lights ${lit.map((i) => i.label).join(", ")}`);
  return lit[0]?.label ?? null;
}

describe("sidebar rows", () => {
  it("has Start musing above four rows, with Usage and Help at the bottom", () => {
    assert.deepEqual(START_MUSING, { href: "/", label: "Start musing", icon: "plus" });
    assert.deepEqual(
      NAV_GROUPS.map((group) => group.map((item) => item.label)),
      [["Musings", "Inspiration", "Fine-tuning", "Devices"]],
    );
    assert.deepEqual(USAGE_ITEM, { href: "/usage", label: "Usage", icon: "usage", also: ["/dashboard"] });
    assert.deepEqual(
      HELP_ITEMS.map((i) => [i.label, i.href]),
      [
        ["How it works", "/how-it-works"],
        ["Model API docs", "/docs"],
      ],
    );
    assert.ok(!ALL.some((item) => item.label === "Dashboard" || item.label === "Make" || item.label === "Builds"));
  });

  it("gives every row a distinct link and icon", () => {
    assert.equal(new Set(ALL.map((i) => i.href)).size, ALL.length);
    assert.equal(new Set(ALL.map((i) => i.icon)).size, ALL.length);
  });

  it("lights Musings on the build list and every build room", () => {
    assert.equal(activeLabel("/builds"), "Musings");
    assert.equal(activeLabel("/b/123"), "Musings");
  });

  it("lights Inspiration on the gallery, Meta demos, the old /rebuilds and every product page", () => {
    for (const path of ["/gallery", "/learn", "/rebuilds", "/p/receipt-sheet", "/p/receipt-sheet/get/apk"]) {
      assert.equal(activeLabel(path), "Inspiration", path);
    }
    assert.equal(activeLabel("/learning"), null);
  });

  it("lights Fine-tuning on its pages and on Models", () => {
    for (const path of ["/fine-tuning", "/fine-tuning/abc", "/fine-tuning/abc/run", "/models", "/models/muse-wonder-1.0"]) {
      assert.equal(activeLabel(path), "Fine-tuning", path);
    }
    assert.equal(activeLabel("/models-old"), null);
  });

  it("lights Devices on Gadgets, /device and Muse Privacy, but not on look-alike paths", () => {
    for (const path of ["/gadgets", "/gadgets/confirm", "/device", "/device/train", "/private"]) {
      assert.equal(activeLabel(path), "Devices", path);
    }
    assert.equal(activeLabel("/devices"), null);
    assert.equal(activeLabel("/device-farm"), null);
    assert.equal(activeLabel("/privacy"), null);
  });

  it("lights Usage on /usage and on the Overview (/dashboard), and Start musing only on /", () => {
    assert.equal(activeLabel("/usage"), "Usage");
    assert.equal(activeLabel("/dashboard"), "Usage");
    assert.equal(activeLabel("/"), "Start musing");
    assert.equal(activeLabel("/sign-in"), null);
    assert.equal(isHelpPath("/how-it-works"), true);
    assert.equal(isHelpPath("/docs/models"), true);
    assert.equal(isHelpPath("/usage"), false);
    const external: NavItem = { href: "https://example.com", label: "X", icon: "external", external: true };
    assert.equal(isActive(external, "https://example.com"), false);
  });

  it("puts each row's pages under it as tabs, shown only on those pages", () => {
    assert.deepEqual(
      Object.values(SECTION_TABS).map((set) => set.tabs.map((t) => t.label)),
      [
        ["Gallery", "Meta demos"],
        ["Fine-tuning", "Models"],
        ["Gadgets", "Muse Privacy"],
        ["Usage", "Overview"],
      ],
    );
    assert.equal(currentTab("inspiration", "/learn")?.label, "Meta demos");
    assert.equal(currentTab("usage", "/dashboard")?.label, "Overview");
    assert.equal(currentTab("tuning", "/fine-tuning/abc"), null);
    // Every tab is a page its sidebar row lights.
    const rowFor: Record<string, string> = { inspiration: "Inspiration", tuning: "Fine-tuning", devices: "Devices", usage: "Usage" };
    for (const [set, { tabs }] of Object.entries(SECTION_TABS)) {
      for (const tab of tabs) assert.equal(activeLabel(tab.href), rowFor[set], tab.href);
    }
  });

  it("keeps the docs sidebar on /docs only", () => {
    assert.equal(isDocsPath("/docs"), true);
    assert.equal(isDocsPath("/docs/models"), true);
    assert.equal(isDocsPath("/models"), false);
  });
});

describe("NavLinks", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let pathname = "/";
  let render: () => string;
  let renderUtility: () => string;

  before(async () => {
    mock.module("next/navigation", { namedExports: { usePathname: () => pathname } });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => {
        const { onClick: _onClick, ...rest } = props;
        return createElement("a", { ...rest, href: String(props.href) });
      },
    });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { NavLinks } = await import("@/components/shell/NavLinks");
    render = () => renderToStaticMarkup(createElement(NavLinks));
    const { UtilityNav } = await import("@/components/shell/UtilityNav");
    renderUtility = () => renderToStaticMarkup(createElement(UtilityNav));
  });

  /** The labels of the rows marked aria-current. */
  function current(path: string): string[] {
    pathname = path;
    return [...render().matchAll(/aria-current="page"[^>]*>.*?<span>([^<]+)<\/span>/g)].map((m) => m[1]);
  }

  it("draws the four rows with their icons, in order", () => {
    pathname = "/";
    const html = render();
    const order = ["/builds", "/gallery", "/fine-tuning", "/gadgets"].map((href) => html.indexOf(`href="${href}"`));
    assert.ok(order.every((at, k) => at > 0 && (k === 0 || at > order[k - 1]!)), "Musings, Inspiration, Fine-tuning, Devices");
    // Each row's icon is a real path in the outline style: a 24 px box, no fill, a 1.5 px stroke.
    for (const href of ["/builds", "/gadgets"]) {
      const row = html.slice(html.indexOf(`href="${href}"`)).split("</a>")[0];
      assert.match(row, /<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"/);
      assert.match(row, /<path d="M[^"]{20,}"/);
    }
  });

  it("marks the row for the page", () => {
    assert.deepEqual(current("/models"), ["Fine-tuning"]);
    assert.deepEqual(current("/device"), ["Devices"]);
    assert.deepEqual(current("/private"), ["Devices"]);
    assert.deepEqual(current("/b/abc"), ["Musings"]);
    assert.deepEqual(current("/p/receipt-sheet"), ["Inspiration"]);
    assert.deepEqual(current("/devices"), []);
    assert.deepEqual(current("/learn"), ["Inspiration"]);
  });

  it("draws Usage and a Help button whose window lists How it works and the Model API docs", () => {
    pathname = "/how-it-works";
    const html = renderUtility();
    assert.ok(html.indexOf('href="/usage"') < html.indexOf(">Help<"), "Usage above Help");
    assert.match(html, /<button type="button" class="nav-link nav-button is-current" aria-haspopup="dialog">/);
    assert.match(html, /<dialog class="settings" aria-labelledby="[^"]+">/);
    assert.match(html, /role="tablist" aria-orientation="vertical"/);
    assert.equal([...html.matchAll(/role="tab"/g)].length, 2);
    // Opens on the section for the page you're on, with its card marked as the current page.
    assert.match(html, /aria-selected="true"[^>]*>.*?How it works/);
    assert.match(html, /<a class="settings-card" href="\/how-it-works" aria-current="page">/);
    assert.match(html, /aria-label="Close help"/);
    pathname = "/usage";
    assert.match(renderUtility(), /<button type="button" class="nav-link nav-button" aria-haspopup="dialog">/);
  });
});
