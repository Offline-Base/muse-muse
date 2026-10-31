/**
 * The flash drive pages, with the store, the model's local files, the viewer and Next's request APIs faked: the offer on
 * a model's page (only while orders are on and the model can go on a drive), the request form's page (off, no model,
 * a model that can't go on a drive, and the form itself with its sizes, US states, 18+ box, terms and "Remember my
 * details"), the order page (only for the link's holder or an admin, with the address, where it stands, what happens
 * next and Cancel until flashing), and the admin queue (admins only, the 2-business-day highlight and each order's
 * actions). Nothing reaches Neon, and no page shows an em dash.
 *
 *   npx tsx --test --experimental-test-module-mocks components/drive/__tests__/pages.test.tsx
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createElement, type ReactNode } from "react";
import type { DriveOrderRow } from "@/lib/drive/logic";
import type { LocalFiles } from "@/lib/train/local-files";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (p: string) => new URL(p, import.meta.url).href;
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";
const EM_DASH = String.fromCharCode(0x2014);
const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const ORDER = "0a1b2c3d-4e5f-4061-8071-8091a0b1c2d3";
const SECRET = "s".repeat(43);
const savedEnv = { ...process.env };

let viewer: { id: string; email: string; isAdmin: boolean } | null = null;
let cookieJar: Record<string, string> = {};
let files: LocalFiles | null = null;
let judged = true;
let rows: DriveOrderRow[] = [];
let calls: string[] = [];

function localFiles(over: Partial<LocalFiles> = {}): LocalFiles {
  return {
    adapterJobId: JOB,
    quantJobId: "9e9e9e9e-0000-4000-8000-000000000009",
    repo: "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b",
    commit: "c".repeat(40),
    public: true,
    files: [
      { level: "Q3_K_M", name: "muse-glimmer-30b-bakery-helper-Q3_K_M.gguf", bytes: 13_680_000_000, sha256: "a".repeat(64) },
      { level: "Q4_K_M", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: "b".repeat(64) },
      { level: "Q6_K", name: "muse-glimmer-30b-bakery-helper-Q6_K.gguf", bytes: 22_870_000_000, sha256: "d".repeat(64) },
    ],
    systemLine: "You are the bakery helper.\n\nReasoning strength: low.",
    needsTunedTemplate: false,
    title: "Bakery helper",
    slug: "bakery-helper",
    ...over,
  };
}

const T0 = new Date("2026-10-26T15:00:00.000Z"); // a Monday

function row(over: Partial<DriveOrderRow> = {}): DriveOrderRow {
  const lf = localFiles();
  return {
    id: ORDER,
    status: "requested",
    payment: "invoice",
    checkoutSessionId: null,
    refundRef: null,
    secretHash: "secrethash",
    trainingJobId: JOB,
    build: "all",
    ggufRepo: lf.repo!,
    ggufCommit: lf.commit!,
    files: lf.files,
    model: { title: lf.title, slug: lf.slug, systemLine: lf.systemLine, needsTunedTemplate: false, quantJobId: lf.quantJobId },
    imageVersion: "2026.10.28-b11669",
    name: "Ada Lovelace",
    email: "ada@example.com",
    address: { line1: "12 Analytical Way", line2: "Apt 4", city: "Austin", state: "TX", postalCode: "78701" },
    invoiceRef: null,
    amountText: null,
    note: null,
    termsVersion: "2026-10-28",
    termsAcceptedAt: T0,
    ageOkAt: T0,
    clientKey: "clientkey",
    browserKey: "browserkey",
    serial: null,
    verifyResult: null,
    manifestSha256: null,
    carrier: null,
    tracking: null,
    cancelledBy: null,
    createdAt: T0,
    invoicedAt: null,
    paidAt: null,
    flashingAt: null,
    checkedAt: null,
    shippedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    purgedAt: null,
    updatedAt: T0,
    ...over,
  };
}

type Page = (props: Record<string, unknown>) => Promise<ReactNode>;
let render: (node: ReactNode) => string;
let newPage: Page;
let orderPage: Page;
let queuePage: Page;
let DriveOffer: (props: { files: LocalFiles | null }) => ReactNode;

function clean(html: string) {
  assert.equal(html.includes(EM_DASH), false, "no em dash");
  assert.doesNotMatch(html, /secrethash|clientkey|browserkey/, "never the secret's hash or the quota keys");
}

describe("flash drive pages", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    // safeQuery runs only with a database configured. Every read is faked, so nothing connects to this.
    process.env.DATABASE_URL = "postgres://drive-pages-test.invalid/db";
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper";
    mock.module("next/navigation", {
      namedExports: {
        notFound: () => {
          throw new Error(NOT_FOUND);
        },
        unstable_rethrow: (err: unknown) => {
          if (err instanceof Error && err.message === NOT_FOUND) throw err;
        },
        useRouter: () => ({ push() {}, refresh() {} }),
        usePathname: () => "/orders",
      },
    });
    mock.module("next/server", { namedExports: { connection: async () => {}, after: () => {} } });
    mock.module("next/headers", {
      namedExports: {
        cookies: async () => ({ get: (name: string) => (name in cookieJar ? { name, value: cookieJar[name] } : undefined) }),
        headers: async () => new Headers(),
      },
    });
    mock.module("next/link", {
      defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
    });
    mock.module(at("../../../app/fine-tuning/viewer.ts"), { namedExports: { pageViewer: async () => viewer } });
    mock.module(at("../../../lib/train/local-files-server.ts"), {
      namedExports: { localFilesFor: async (id: string) => (calls.push("localFilesFor"), files && id === files.adapterJobId ? files : null) },
    });
    mock.module(at("../../../lib/train/store.ts"), {
      namedExports: { getResultJob: async (id: string) => (calls.push("getResultJob"), judged && id === JOB ? { id } : null) },
    });
    mock.module(at("../../../lib/drive/store.ts"), {
      namedExports: {
        orderForSecret: async (id: string, secret: string | null | undefined) => {
          calls.push("orderForSecret");
          return secret === SECRET ? (rows.find((r) => r.id === id) ?? null) : null;
        },
        getOrder: async (id: string) => (calls.push("getOrder"), rows.find((r) => r.id === id) ?? null),
        listOrders: async () => {
          calls.push("listOrders");
          const closed = ["delivered", "cancelled"];
          return { open: rows.filter((r) => !closed.includes(r.status)), closed: rows.filter((r) => closed.includes(r.status)) };
        },
        purgeDriveOrders: async () => (calls.push("purgeDriveOrders"), { buyers: 0, keys: 0, unpaid: 0 }),
        // The card checkout's writes (lib/drive/checkout.ts): the pages only reach them with ?session=.
        markCardPaid: async () => null,
        setCheckoutSession: async () => null,
        setRefund: async () => null,
        appendNote: async () => {},
      },
    });
    const { renderToString } = await import("react-dom/server");
    render = (node) => renderToString(node as never).replace(/<!-- -->/g, "");
    newPage = (await import(at("../../../app/orders/new/page.tsx"))).default as Page;
    orderPage = (await import(at("../../../app/orders/[id]/page.tsx"))).default as Page;
    queuePage = (await import(at("../../../app/fine-tuning/orders/page.tsx"))).default as Page;
    ({ DriveOffer } = await import(at("../DriveOffer.tsx")));
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    viewer = { id: "guest", email: "guest@musemuse.invalid", isAdmin: false };
    cookieJar = {};
    files = localFiles();
    judged = true;
    rows = [row()];
    calls = [];
    process.env.DRIVE_ENABLED = "1";
    delete process.env.DRIVE_PRICE_TEXT;
    delete process.env.DRIVE_TERMS_VERSION;
  });

  describe("the offer on a model's page", () => {
    it("shows only while orders are on and the model can go on a drive", () => {
      const html = render(DriveOffer({ files: localFiles() }));
      clean(html);
      assert.match(html, /<h2 id="drive-offer-title">Get it on a flash drive<\/h2>/);
      assert.match(html, /All three sizes of this model and a llama\.cpp runtime on one USB stick/);
      assert.match(html, /runs offline on a Mac with Apple silicon and 24 GB of memory or more, or a Windows PC with a 16 GB graphics card or 32 GB of memory/);
      assert.match(html, /Q4_K_M · 16\.9 GB/);
      assert.match(html, /We&#x27;ll email you a quote before anything is charged\./);
      assert.match(html, new RegExp(`href="/orders/new\\?model=${JOB}"[^>]*>Request a drive`));
      assert.match(html, new RegExp(`href="/fine-tuning/${JOB}/run"[^>]*>Check your computer first`));
      assert.match(html, /Smart App Control on aren&#x27;t/);

      process.env.DRIVE_PRICE_TEXT = "$59 with US shipping, invoiced by email";
      assert.match(render(DriveOffer({ files: localFiles() })), /\$59 with US shipping, invoiced by email/);
      assert.equal(render(DriveOffer({ files: localFiles({ public: false }) })), "");
      assert.equal(render(DriveOffer({ files: localFiles({ files: [] }) })), "");
      assert.equal(render(DriveOffer({ files: null })), "");
      delete process.env.DRIVE_ENABLED;
      assert.equal(render(DriveOffer({ files: localFiles() })), "", "off by default");
    });
  });

  describe("the request form's page", () => {
    const open = async (model: string | null = JOB) => render(await newPage({ searchParams: Promise.resolve(model ? { model } : {}) }));

    it("says so when orders are off, no model is named, or the model can't go on a drive", async () => {
      delete process.env.DRIVE_ENABLED;
      const off = await open();
      clean(off);
      assert.match(off, /Flash drive orders are off/);
      assert.doesNotMatch(off, /<form/);
      assert.deepEqual(calls, [], "nothing is read while orders are off");

      process.env.DRIVE_ENABLED = "1";
      assert.match(await open(null), /Pick a model first/);
      assert.match(await open("not-a-uuid"), /Pick a model first/);
      files = localFiles({ public: false });
      const priv = await open();
      assert.match(priv, /This model can&#x27;t go on a drive/);
      assert.match(priv, /This model&#x27;s local files aren&#x27;t public yet\./);
      judged = false;
      files = localFiles();
      assert.match(await open(), /This model has no public results page/);
    });

    it("shows what is on the drive, the price and the one-screen form", async () => {
      const html = await open();
      clean(html);
      assert.match(html, /<h1>Get it on a flash drive<\/h1>/);
      assert.match(html, /Bakery helper in 3 sizes, a llama\.cpp runtime/);
      assert.match(html, /It runs on a Mac with Apple silicon and 24 GB of memory or more/);
      assert.match(html, /We&#x27;ll email you a quote before anything is charged\./);
      assert.match(html, /Nothing is charged on this site\. We email you an invoice with the price within 2 business days\./);
      assert.match(html, /US addresses only for now/);
      assert.match(html, /Not made, reviewed or endorsed by Meta/);
      assert.match(html, /<legend class="train-label">What goes on the drive<\/legend>/);
      assert.match(html, /<input[^>]*type="radio"[^>]*checked=""[^>]*value="all"\/>/, "all three sizes by default");
      for (const level of ["Q3_K_M", "Q4_K_M", "Q6_K"]) assert.match(html, new RegExp(`value="${level}"`));
      assert.match(html, /autoComplete="address-line1"/);
      assert.match(html, /<option value="TX">Texas<\/option>/);
      assert.match(html, /<option value="PR">Puerto Rico<\/option>/);
      assert.doesNotMatch(html, /<option value="ON">/, "US only");
      assert.match(html, /I&#x27;m 18 or older\./);
      assert.match(html, /I accept the terms\./);
      assert.match(html, /Remember my details on this device\. They stay in this browser only/);
      assert.match(html, /This is a request, not a purchase\. Nothing is charged on this site\./);
      assert.match(html, /delete them 60 days after delivery or cancellation/);
      assert.match(html, /Send the request/);
      assert.match(html, /href="https:\/\/huggingface\.co\/musemuse\/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b"/);
      // Each single size says which computer it is for, from the picker's own numbers.
      assert.match(html, /<strong>Q4_K_M only<\/strong><span class="muted small">For a Mac with 32 GB or more, or a 20 GB graphics card\. On a 32 GB stick\.<\/span>/);
      // The picker and its verdict come before the form, so nobody orders a drive their computer can't run.
      assert.ok(html.indexOf("Your computer</h2>") > 0 && html.indexOf("Will it run?") < html.indexOf("Request a drive</h2>"));
      assert.doesNotMatch(html, /Get it running|<dt>Download<\/dt>/);
      assert.doesNotMatch(html, /Questions\? Write to/, "no address until DRIVE_CONTACT_EMAIL names one");
    });

    it("names where to write once DRIVE_CONTACT_EMAIL is set", async () => {
      process.env.DRIVE_CONTACT_EMAIL = "drives@example.com";
      try {
        assert.match(await open(), /Questions\? Write to <a href="mailto:drives@example\.com">drives@example\.com<\/a>\./);
      } finally {
        delete process.env.DRIVE_CONTACT_EMAIL;
      }
    });

    it("offers one size only when only one passed its checks", async () => {
      files = localFiles({ files: localFiles().files.slice(1, 2) });
      const html = await open();
      assert.doesNotMatch(html, /value="all"/);
      assert.match(html, /<input type="radio"[^>]*checked=""[^>]*value="Q4_K_M"\/>/);
      assert.match(html, /Bakery helper in its one size/);
      // Two sizes are "Both sizes", never "All three" or "All 2".
      files = localFiles({ files: localFiles().files.slice(0, 2) });
      const two = await open();
      assert.match(two, /<strong>Both sizes<\/strong>/);
      assert.doesNotMatch(two, /All three sizes|All 2 sizes/);
    });
  });

  describe("the order page", () => {
    const open = async (id = ORDER) => render(await orderPage({ params: Promise.resolve({ id }) }));

    it("opens only for the link's holder or an admin", async () => {
      await assert.rejects(open(), new RegExp(NOT_FOUND), "no cookie");
      cookieJar = { [`mm_order_${ORDER}`]: "t".repeat(43) };
      await assert.rejects(open(), new RegExp(NOT_FOUND), "another secret");
      cookieJar = { [`mm_order_${ORDER}`]: SECRET };
      const html = await open();
      clean(html);
      assert.match(html, /<h1>Your flash drive order<\/h1>/);

      cookieJar = {};
      viewer = { id: "admin", email: "owner@example.com", isAdmin: true };
      const admin = await open();
      assert.match(admin, /href="\/fine-tuning\/orders"/);
      assert.doesNotMatch(admin, /Cancel the order/, "an admin cancels from the queue");
    });

    it("shows the buyer's address, where it stands, what happens next, and Cancel until flashing", async () => {
      cookieJar = { [`mm_order_${ORDER}`]: SECRET };
      const html = await open();
      clean(html);
      assert.match(html, /<span class="pill pill-building"><span class="pill-dot" aria-hidden="true"><\/span>Requested<\/span>/);
      assert.match(html, /We&#x27;ll email an invoice to ada@example\.com within 2 business days\. Nothing is charged until you pay it\./);
      assert.match(html, /<address class="drive-address"><span>Ada Lovelace<\/span><span>12 Analytical Way<\/span><span>Apt 4<\/span><span>Austin, TX 78701<\/span><\/address>/);
      assert.match(html, /<li class="rail-step rail-active" aria-current="step">/);
      assert.match(html, /Cancel the order/);
      for (const level of ["Q3_K_M", "Q4_K_M", "Q6_K"]) assert.match(html, new RegExp(`<dt>${level}</dt>`));

      rows = [row({ status: "invoiced", invoicedAt: new Date(T0.getTime() + 3_600_000), invoiceRef: "INV-7", amountText: "$59" })];
      assert.match(await open(), /We emailed invoice INV-7 for \$59 to ada@example\.com/);
      rows = [row({ status: "flashing", flashingAt: T0, serial: "MM-0A1B2C3D4E5F" })];
      const flashing = await open();
      assert.doesNotMatch(flashing, /Cancel the order/, "too late to cancel");
      rows = [row({ status: "shipped", shippedAt: T0, carrier: "USPS", tracking: "9400111899223" })];
      const shipped = await open();
      assert.match(shipped, /It&#x27;s on its way with USPS\. The tracking number is 9400111899223\. When it arrives, plug it in and open Start Here\.html\./);
      assert.match(shipped, /href="https:\/\/tools\.usps\.com\/go\/TrackConfirmAction\?tLabels=9400111899223"/);
    });

    it("says what a cancel does to a payment, where to write, and the times in the reader's own clock", async () => {
      cookieJar = { [`mm_order_${ORDER}`]: SECRET };
      rows = [row({ status: "cancelled", cancelledAt: T0, cancelledBy: "buyer" })];
      assert.match(await open(), /You cancelled this order\. Nothing was charged\./);
      rows = [row({ status: "cancelled", paidAt: T0, cancelledAt: T0, cancelledBy: "admin", invoicedAt: T0 })];
      const refunded = await open();
      assert.match(refunded, /This order was cancelled\. We&#x27;ll refund what you paid/);
      assert.match(refunded, /Questions about your order\? Reply to your invoice&#x27;s email\./);
      // The server can't know the reader's time zone: a <time> the browser turns into local time once it mounts.
      assert.match(refunded, new RegExp(`<time dateTime="${T0.toISOString()}">`));
      process.env.DRIVE_CONTACT_EMAIL = "drives@example.com";
      try {
        assert.match(await open(), /Questions about your order\? Write to <a href="mailto:drives@example\.com">drives@example\.com<\/a>\./);
      } finally {
        delete process.env.DRIVE_CONTACT_EMAIL;
      }
      // An admin sees the same page, titled as theirs to look at.
      cookieJar = {};
      viewer = { id: "admin", email: "owner@example.com", isAdmin: true };
      const admin = await open();
      assert.match(admin, /<h1>Flash drive order<\/h1>/);
      assert.match(admin, /What the buyer reads next/);
      assert.doesNotMatch(admin, /Questions about your order/);
    });

    it("says the buyer's details are gone once purged", async () => {
      cookieJar = { [`mm_order_${ORDER}`]: SECRET };
      rows = [row({ status: "delivered", deliveredAt: T0, name: null, email: null, address: null, purgedAt: T0 })];
      const html = await open();
      clean(html);
      assert.match(html, /We deleted the name, email and address on this order 60 days after it ended\./);
      assert.doesNotMatch(html, /Ada|Analytical/);
      assert.match(html, /pill pill-live/);
    });
  });

  describe("the admin queue", () => {
    const open = async () => render(await queuePage({}));

    it("is for admins only", async () => {
      const guest = await open();
      assert.match(guest, /Admins only/);
      assert.doesNotMatch(guest, /Ada|ada@/);
      assert.deepEqual(calls, []);
      viewer = null;
      assert.match(await open(), /href="\/sign-in\?next=%2Ffine-tuning%2Forders"/);
    });

    it("lists open orders with the buyer, the highlight past 2 business days, and the actions each allows", async () => {
      viewer = { id: "admin", email: "owner@example.com", isAdmin: true };
      rows = [
        row(),
        row({ id: "1a1b2c3d-4e5f-4061-8071-8091a0b1c2d3", status: "checked", checkedAt: new Date(), serial: "MM-1A1B2C3D4E5F", createdAt: new Date() }),
        row({ id: "2a1b2c3d-4e5f-4061-8071-8091a0b1c2d3", status: "delivered", deliveredAt: new Date(), createdAt: new Date() }),
      ];
      const html = await open();
      clean(html);
      assert.deepEqual(calls.slice(0, 2), ["purgeDriveOrders", "listOrders"], "purged before it reads");
      assert.match(html, /<h1>Drive orders<\/h1>/);
      assert.match(html, /<tr class="drive-overdue">/, "requested on a Monday, not invoiced by Wednesday");
      assert.match(html, /Over 2 business days/);
      assert.match(html, /<a href="mailto:ada@example\.com">ada@example\.com<\/a>/);
      assert.match(html, /<summary>Ship to<\/summary>/);
      assert.match(html, />Mark invoiced<\/button>/, "each button says what it does");
      assert.match(html, />Mark shipped<\/button>/);
      assert.match(html, />Cancel order<\/button>/);
      assert.match(html, /<th scope="col">Closed<\/th>/, "the closed table says when each ended");
      assert.match(html, /MM-1A1B2C3D4E5F/);
      assert.match(html, /<h2 id="orders-closed">Delivered and cancelled<\/h2>/);
      assert.doesNotMatch(html, />Flashing<\/button>|>Checked<\/button>/, "those come from the bench");
      assert.match(html, /<dt>To invoice<\/dt><dd>1, 1 of them over 2 business days<\/dd>/);
      assert.match(html, /<dt>To ship<\/dt><dd>1<\/dd>/);
      assert.match(html, /Requests are on \(DRIVE_ENABLED\)\./);
    });

    it("flags a refund owed on an order cancelled after it was paid", async () => {
      viewer = { id: "admin", email: "owner@example.com", isAdmin: true };
      rows = [row({ status: "cancelled", paidAt: T0, cancelledAt: new Date(), createdAt: new Date() }), row({ id: "1a1b2c3d-4e5f-4061-8071-8091a0b1c2d3", status: "cancelled", cancelledAt: new Date(), createdAt: new Date() })];
      const html = await open();
      assert.equal((html.match(/<span class="drive-flag">Refund owed<\/span>/g) ?? []).length, 1);
    });
  });
});
