/**
 * The platform's sidebar rows (components/shell/nav.ts): which rows there are, in what order, which one each path
 * lights, and that NavLinks, which the desktop sidebar and the phone menu both render through ShellNav, marks it.
 *
 *   npx tsx --test --experimental-test-module-mocks components/shell/__tests__/nav.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement } from "react";
import { NAV_GROUPS, isActive, isDocsPath, type NavItem } from "@/components/shell/nav";

const canMock = typeof (mock as { module?: unknown }).module === "function";

/** The row a path lights, by label, or null. Exactly one row may light up. */
function activeLabel(pathname: string): string | null {
  const lit = NAV_GROUPS.flat().filter((item) => isActive(item, pathname));
  assert.ok(lit.length <= 1, `${pathname} lights ${lit.map((i) => i.label).join(", ")}`);
  return lit[0]?.label ?? null;
}

describe("sidebar rows", () => {
  it("has Models and Gadgets in the account group, around Fine-tuning", () => {
    assert.deepEqual(
      NAV_GROUPS.map((group) => group.map((item) => item.label)),
      [
        ["Dashboard"],
        ["Make", "Builds", "Learn", "Gallery"],
        ["Usage", "Models", "Fine-tuning", "Gadgets", "Muse Privacy"],
        ["How it works", "Docs"],
      ],
    );
    const byLabel = new Map(NAV_GROUPS.flat().map((item) => [item.label, item] as const));
    assert.deepEqual(byLabel.get("Models"), { href: "/models", label: "Models", icon: "cube" });
    assert.deepEqual(byLabel.get("Gadgets"), { href: "/gadgets", label: "Gadgets", icon: "chip", also: ["/device"] });
  });

  it("gives every row a distinct link and icon", () => {
    const items = NAV_GROUPS.flat();
    assert.equal(new Set(items.map((i) => i.href)).size, items.length);
    assert.equal(new Set(items.map((i) => i.icon)).size, items.length);
  });

  it("lights Models on /models and below", () => {
    assert.equal(activeLabel("/models"), "Models");
    assert.equal(activeLabel("/models/muse-wonder-1.0"), "Models");
    assert.equal(activeLabel("/models-old"), null);
  });

  it("lights Gadgets on /gadgets, /device and below, but not on look-alike paths", () => {
    assert.equal(activeLabel("/gadgets"), "Gadgets");
    assert.equal(activeLabel("/gadgets/boards"), "Gadgets");
    assert.equal(activeLabel("/device"), "Gadgets");
    assert.equal(activeLabel("/device/train"), "Gadgets");
    assert.equal(activeLabel("/devices"), null);
    assert.equal(activeLabel("/device-farm"), null);
  });

  it("lights Learn on /learn and on the old /rebuilds, which redirects there", () => {
    assert.equal(activeLabel("/learn"), "Learn");
    assert.equal(activeLabel("/rebuilds"), "Learn");
    assert.equal(activeLabel("/learning"), null);
    const learn = NAV_GROUPS.flat().find((item) => item.label === "Learn");
    assert.deepEqual(learn, { href: "/learn", label: "Learn", icon: "cap", also: ["/rebuilds"] });
    assert.ok(!NAV_GROUPS.flat().some((item) => item.label === "Rebuilds"));
  });

  it("keeps the other rows lighting as before", () => {
    assert.equal(activeLabel("/"), "Make");
    assert.equal(activeLabel("/b/123"), "Builds");
    assert.equal(activeLabel("/builds"), "Builds");
    assert.equal(activeLabel("/p/receipt-sheet"), "Gallery");
    assert.equal(activeLabel("/fine-tuning/abc"), "Fine-tuning");
    assert.equal(activeLabel("/fine-tuning/abc/run"), "Fine-tuning");
    assert.equal(activeLabel("/usage"), "Usage");
    assert.equal(activeLabel("/dashboard"), "Dashboard");
    assert.equal(activeLabel("/sign-in"), null);
    const external: NavItem = { href: "https://example.com", label: "X", icon: "external", external: true };
    assert.equal(isActive(external, "https://example.com"), false);
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
  });

  /** The labels of the rows marked aria-current. */
  function current(path: string): string[] {
    pathname = path;
    return [...render().matchAll(/aria-current="page"[^>]*>.*?<span>([^<]+)<\/span>/g)].map((m) => m[1]);
  }

  it("draws both new rows with their icons, in order", () => {
    pathname = "/";
    const html = render();
    const models = html.indexOf('href="/models"');
    const tuning = html.indexOf('href="/fine-tuning"');
    const gadgets = html.indexOf('href="/gadgets"');
    assert.ok(models > html.indexOf('href="/usage"') && tuning > models && gadgets > tuning, "Usage, Models, Fine-tuning, Gadgets");
    // Each row's icon is a real path in the outline style: a 24 px box, no fill, a 1.5 px stroke.
    for (const href of ["/models", "/gadgets"]) {
      const row = html.slice(html.indexOf(`href="${href}"`)).split("</a>")[0];
      assert.match(row, /<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"/);
      assert.match(row, /<path d="M[^"]{20,}"/);
    }
  });

  it("marks the row for the page", () => {
    assert.deepEqual(current("/models"), ["Models"]);
    assert.deepEqual(current("/gadgets"), ["Gadgets"]);
    assert.deepEqual(current("/device"), ["Gadgets"]);
    assert.deepEqual(current("/fine-tuning"), ["Fine-tuning"]);
    assert.deepEqual(current("/devices"), []);
    assert.deepEqual(current("/learn"), ["Learn"]);
  });
});
