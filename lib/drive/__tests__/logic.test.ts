/**
 * The pure rules of flash drive orders (lib/drive/logic.ts): every status move and who may make it (the buyer cancels
 * only before flashing, a FAIL never reaches checked), the request's checks (the 18+ box, US addresses only, bounded
 * fields, no control characters or "<|"), which models may be ordered, the minimum spec sentence, the 2-business-day
 * highlight, the purge's cutoffs, the owner's summary (never the buyer's details) and the views. Nothing here touches a
 * database or the network.
 *
 *   npx tsx --test lib/drive/__tests__/logic.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addBusinessDays,
  buildLabel,
  buyerCanCancel,
  canMove,
  cookieValue,
  DEFAULT_PRICE_LINE,
  driveModelOf,
  driveProblem,
  filesForBuild,
  gb,
  invoiceOverdue,
  minimumSpecText,
  movableFrom,
  nextStatuses,
  normalizeZip,
  orderLink,
  ownerSummary,
  parseAdminChange,
  parseBenchReport,
  parseDriveRequest,
  priceLine,
  purgeCutoffs,
  serialFor,
  statusSince,
  toAdminRow,
  toBenchOrder,
  toOrderView,
  type DriveOrderRow,
} from "@/lib/drive/logic";
import { DRIVE_STATUSES, type DriveActor, type DriveStatus } from "@/lib/drive/types";
import type { LocalFiles } from "@/lib/train/local-files";

const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const ORDER = "0a1b2c3d-4e5f-4061-8071-8091a0b1c2d3";
const T0 = new Date("2026-10-28T15:00:00.000Z"); // a Wednesday

const sha = (c: string) => c.repeat(64);

function localFiles(over: Partial<LocalFiles> = {}): LocalFiles {
  return {
    adapterJobId: JOB,
    quantJobId: "9e9e9e9e-0000-4000-8000-000000000009",
    repo: "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b",
    commit: "c".repeat(40),
    public: true,
    files: [
      { level: "Q6_K", name: "muse-glimmer-30b-bakery-helper-Q6_K.gguf", bytes: 22_870_000_000, sha256: sha("c") },
      { level: "Q3_K_M", name: "muse-glimmer-30b-bakery-helper-Q3_K_M.gguf", bytes: 13_680_000_000, sha256: sha("a") },
      { level: "Q4_K_M", name: "muse-glimmer-30b-bakery-helper-Q4_K_M.gguf", bytes: 16_940_000_000, sha256: sha("B") },
    ],
    systemLine: "You are the bakery helper.\n\nReasoning strength: low.",
    needsTunedTemplate: false,
    title: "Bakery helper",
    slug: "bakery-helper",
    ...over,
  };
}

function request(over: Record<string, unknown> = {}, address: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trainingJobId: JOB,
    build: "all",
    name: "  Ada   Lovelace ",
    email: "ada@example.com",
    address: { line1: "12 Analytical Way", city: "Austin", state: "tx", postalCode: "78701", ...address },
    ageOk: true,
    termsVersion: "2026-10-28",
    ...over,
  };
}

function row(over: Partial<DriveOrderRow> = {}): DriveOrderRow {
  const files = filesForBuild(localFiles().files, "all")!;
  return {
    id: ORDER,
    status: "requested",
    payment: "invoice",
    checkoutSessionId: null,
    refundRef: null,
    secretHash: "secrethash".padEnd(64, "0"),
    trainingJobId: JOB,
    build: "all",
    ggufRepo: localFiles().repo!,
    ggufCommit: localFiles().commit!,
    files,
    model: { title: "Bakery helper", slug: "bakery-helper", systemLine: localFiles().systemLine, needsTunedTemplate: false, quantJobId: localFiles().quantJobId },
    imageVersion: "2026.10.28-b11669",
    name: "Ada Lovelace",
    email: "ada@example.com",
    address: { line1: "12 Analytical Way", city: "Austin", state: "TX", postalCode: "78701" },
    invoiceRef: null,
    amountText: null,
    note: null,
    termsVersion: "2026-10-28",
    termsAcceptedAt: T0,
    ageOkAt: T0,
    clientKey: "clientkey".padEnd(64, "0"),
    browserKey: "browserkey".padEnd(64, "0"),
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

describe("status moves", () => {
  const allowed: Array<[DriveStatus, DriveStatus, DriveActor]> = [
    ["requested", "invoiced", "admin"],
    ["requested", "cancelled", "buyer"],
    ["requested", "cancelled", "admin"],
    ["invoiced", "paid", "admin"],
    ["invoiced", "cancelled", "buyer"],
    ["invoiced", "cancelled", "admin"],
    ["paid", "flashing", "bench"],
    ["paid", "cancelled", "buyer"],
    ["paid", "cancelled", "admin"],
    ["flashing", "checked", "bench"],
    ["flashing", "paid", "bench"],
    ["flashing", "cancelled", "admin"],
    ["checked", "shipped", "admin"],
    ["checked", "cancelled", "admin"],
    ["shipped", "delivered", "admin"],
  ];

  it("allows exactly the moves in the design, each for its actor", () => {
    const key = (m: [DriveStatus, DriveStatus, DriveActor]) => m.join(">");
    const ok = new Set(allowed.map(key));
    for (const from of DRIVE_STATUSES) {
      for (const to of DRIVE_STATUSES) {
        for (const actor of ["buyer", "admin", "bench"] as DriveActor[]) {
          assert.equal(canMove(from, to, actor), ok.has(key([from, to, actor])), `${from} -> ${to} by ${actor}`);
        }
      }
    }
  });

  it("lets the buyer cancel until the stick is being written, and never after", () => {
    assert.deepEqual(
      DRIVE_STATUSES.filter(buyerCanCancel),
      ["requested", "invoiced", "paid"],
    );
    assert.deepEqual(movableFrom("cancelled", "buyer"), ["requested", "invoiced", "paid"]);
  });

  it("never lets anyone but the bench make an order checked, and only from flashing", () => {
    assert.deepEqual(movableFrom("checked", "bench"), ["flashing"]);
    assert.deepEqual(movableFrom("checked", "admin"), []);
    assert.deepEqual(movableFrom("checked", "buyer"), []);
    // Flashing and checked come only from the bench script.
    assert.deepEqual(movableFrom("flashing", "admin"), []);
  });

  it("ends at delivered and cancelled", () => {
    for (const actor of ["buyer", "admin", "bench"] as DriveActor[]) {
      assert.deepEqual(nextStatuses("delivered", actor), []);
      assert.deepEqual(nextStatuses("cancelled", actor), []);
    }
    assert.deepEqual(nextStatuses("requested", "admin"), ["invoiced", "cancelled"]);
  });

  it("knows when an order reached where it is", () => {
    const paidAt = new Date(T0.getTime() + 86_400_000);
    assert.equal(statusSince(row({ status: "paid", paidAt })).toISOString(), paidAt.toISOString());
    assert.equal(statusSince(row({ status: "requested" })).toISOString(), T0.toISOString());
    // A missing stamp falls back to when it was requested.
    assert.equal(statusSince(row({ status: "shipped" })).toISOString(), T0.toISOString());
  });
});

describe("the request", () => {
  it("takes a full US request and tidies it", () => {
    const got = parseDriveRequest(request());
    assert.ok(got.ok);
    assert.deepEqual(got.value, {
      trainingJobId: JOB,
      build: "all",
      name: "Ada Lovelace",
      email: "ada@example.com",
      address: { line1: "12 Analytical Way", city: "Austin", state: "TX", postalCode: "78701" },
      termsVersion: "2026-10-28",
    });
    const nine = parseDriveRequest(request({ build: "Q4_K_M" }, { line2: " Apt 4 ", postalCode: "787011234" }));
    assert.ok(nine.ok);
    assert.equal(nine.value.address.postalCode, "78701-1234");
    assert.equal(nine.value.address.line2, "Apt 4");
    assert.equal(nine.value.build, "Q4_K_M");
  });

  it("needs the 18+ box and the terms", () => {
    for (const ageOk of [undefined, false, "true", 1]) {
      const got = parseDriveRequest(request({ ageOk }));
      assert.ok(!got.ok);
      assert.equal(got.field, "ageOk");
      assert.match(got.error, /18 or older/);
    }
    const terms = parseDriveRequest(request({ termsVersion: "" }));
    assert.ok(!terms.ok);
    assert.equal(terms.field, "terms");
  });

  it("takes US addresses only: a two-letter state and a 5 or 9 digit ZIP", () => {
    for (const [address, field] of [
      [{ state: "ON" }, "state"],
      [{ state: "Texas" }, "state"],
      [{ state: "" }, "state"],
      [{ postalCode: "K1A 0B1" }, "postalCode"],
      [{ postalCode: "7870" }, "postalCode"],
      [{ postalCode: "78701-12" }, "postalCode"],
      [{ city: "" }, "city"],
      [{ line1: "   " }, "line1"],
    ] as const) {
      const got = parseDriveRequest(request({}, address));
      assert.ok(!got.ok, JSON.stringify(address));
      assert.equal(got.field, field);
    }
    assert.equal(normalizeZip("78701-1234"), "78701-1234");
    assert.equal(normalizeZip(" 78701 "), "78701");
    assert.equal(normalizeZip("787011"), null);
    for (const state of ["PR", "DC", "AE", "gu"]) assert.ok(parseDriveRequest(request({}, { state })).ok, state);
  });

  it("refuses control characters, bidi overrides and <| in any field, and bounds every field", () => {
    for (const [over, address, field] of [
      [{ name: "Ada\u0000" }, {}, "name"],
      [{ name: "Ada <|start|>" }, {}, "name"],
      [{}, { line1: "12 Way‮" }, "line1"],
      [{}, { city: "Aus\ntin" }, "city"],
      [{ email: "ada@example.com\u0007" }, {}, "email"],
      [{ name: "x".repeat(101) }, {}, "name"],
      [{}, { line2: "y".repeat(101) }, "line2"],
      [{ email: `${"e".repeat(195)}@x.com` }, {}, "email"],
      [{ email: "not an email" }, {}, "email"],
      [{ name: 42 }, {}, "name"],
    ] as const) {
      const got = parseDriveRequest(request(over, address));
      assert.ok(!got.ok, JSON.stringify([over, address]));
      assert.equal(got.field, field);
    }
  });

  it("needs a model id and a known build", () => {
    assert.equal((parseDriveRequest(request({ trainingJobId: "x" })) as { field: string }).field, "trainingJobId");
    assert.equal((parseDriveRequest(request({ build: "Q8_0" })) as { field: string }).field, "build");
    assert.equal((parseDriveRequest(request({ address: "12 Way" })) as { field: string }).field, "line1");
  });
});

describe("which models may be ordered", () => {
  it("saves with the order whether its files are a Derivative of Muse Spark Open, so the drive ships its licenses", () => {
    assert.equal(driveModelOf(localFiles({ sparkOpen: true })).sparkOpen, true);
    assert.ok(!("sparkOpen" in driveModelOf(localFiles())), "an order of plain Glimmer files is saved as before");
  });

  it("needs orders on, a public results page, a public GGUF repo at a commit, and a build that passed", () => {
    const ok = { enabled: true, judged: true, files: localFiles() };
    assert.equal(driveProblem(ok), null);
    assert.match(driveProblem({ ...ok, enabled: false })!, /off/);
    assert.match(driveProblem({ ...ok, judged: false })!, /no public results page/);
    assert.match(driveProblem({ ...ok, files: null })!, /no local files/);
    assert.match(driveProblem({ ...ok, files: localFiles({ public: false }) })!, /aren't public/);
    assert.match(driveProblem({ ...ok, files: localFiles({ commit: null }) })!, /aren't public/);
    assert.match(driveProblem({ ...ok, files: localFiles({ files: [] }) })!, /passed their checks/);
    assert.match(driveProblem({ ...ok, files: localFiles({ quantBase: "llama-3.2-3b" }) })!, /small Llama/, "a drive's license files are Muse Glimmer's");
  });

  it("puts every build that passed on an all-sizes drive, smallest first, and one build alone otherwise", () => {
    const all = filesForBuild(localFiles().files, "all")!;
    assert.deepEqual(all.map((f) => f.level), ["Q3_K_M", "Q4_K_M", "Q6_K"]);
    assert.equal(all[1].sha256, sha("b"), "sha256 lowercased");
    assert.deepEqual(filesForBuild(localFiles().files, "Q6_K")!.map((f) => f.level), ["Q6_K"]);
    const twoPassed = localFiles().files.filter((f) => f.level !== "Q6_K");
    assert.equal(filesForBuild(twoPassed, "Q6_K"), null, "a build that failed its checks can't be ordered");
    assert.equal(filesForBuild(twoPassed, "all")!.length, 2);
  });

  it("prints sizes in decimal gigabytes", () => {
    assert.equal(gb(16_940_000_000), "16.9 GB");
    assert.equal(gb(1_400_000_000), "1.40 GB");
  });

  it("shows the owner's price, or says a quote comes first", () => {
    assert.equal(priceLine(null), DEFAULT_PRICE_LINE);
    assert.equal(priceLine("  "), DEFAULT_PRICE_LINE);
    assert.equal(priceLine("$59 \u2014 with US shipping"), "$59, with US shipping");
  });
});

describe("the least a computer needs", () => {
  it("says it in one sentence from the device picker's numbers", () => {
    assert.equal(
      minimumSpecText({ macGb: 24, vramGb: 16, ramGb: 32 }),
      "a Mac with Apple silicon and 24 GB of memory or more, or a Windows PC with a 16 GB graphics card or 32 GB of memory",
    );
    assert.equal(minimumSpecText({ macGb: 48, vramGb: 32, ramGb: null }), "a Mac with Apple silicon and 48 GB of memory or more, or a Windows PC with a 32 GB graphics card");
    assert.equal(minimumSpecText({ macGb: null, vramGb: null, ramGb: null }), "");
  });
});

describe("dates", () => {
  it("highlights a request nobody invoiced within 2 business days, weekends left out", () => {
    // Wednesday 15:00 -> Friday 15:00.
    assert.equal(addBusinessDays(T0, 2).toISOString(), "2026-10-30T15:00:00.000Z");
    // Friday -> Tuesday, Saturday -> Tuesday.
    assert.equal(addBusinessDays(new Date("2026-10-30T09:00:00Z"), 2).toISOString(), "2026-11-03T09:00:00.000Z");
    assert.equal(addBusinessDays(new Date("2026-10-31T09:00:00Z"), 2).toISOString(), "2026-11-03T09:00:00.000Z");
    const r = row();
    assert.equal(invoiceOverdue(r, new Date("2026-10-30T14:59:00Z")), false);
    assert.equal(invoiceOverdue(r, new Date("2026-10-30T15:01:00Z")), true);
    assert.equal(invoiceOverdue(row({ status: "invoiced" }), new Date("2026-11-30T00:00:00Z")), false, "only requests wait for an invoice");
  });

  it("purges buyers 60 days after, or 74 days after shipping an order nobody marked delivered, and quota keys 30 days after", () => {
    const cut = purgeCutoffs(T0);
    assert.equal(T0.getTime() - cut.buyer.getTime(), 60 * 86_400_000);
    assert.equal(T0.getTime() - cut.shipped.getTime(), 74 * 86_400_000);
    assert.equal(T0.getTime() - cut.keys.getTime(), 30 * 86_400_000);
  });
});

describe("links, serials and cookies", () => {
  it("makes the link that saves the secret, and one serial per order", () => {
    assert.equal(orderLink("https://muse.example.com/", ORDER, "abc_-"), `https://muse.example.com/orders/${ORDER}/open?k=abc_-`);
    assert.equal(serialFor(ORDER), "MM-0A1B2C3D4E5F");
    assert.notEqual(serialFor(ORDER), serialFor("0a1b2c3d-4e5f-4061-8071-8091a0b1c2d4".replace("0a1b", "0a1c")));
  });

  it("reads one cookie from a header", () => {
    assert.equal(cookieValue("a=1; mm_order_x=s3cr%3Det; b=2", "mm_order_x"), "s3cr=et");
    assert.equal(cookieValue("a=1", "mm_order_x"), null);
    assert.equal(cookieValue(null, "a"), null);
    assert.equal(cookieValue("x_a=1; a=2", "a"), "2");
  });
});

describe("the owner's summary", () => {
  it("names the model, the build and the order, never the buyer", () => {
    const text = ownerSummary({ title: "Bakery helper", build: "Q4_K_M", count: 1, orderId: ORDER, waiting: 2, adminUrl: "https://muse.example.com/fine-tuning/orders" });
    assert.equal(
      text,
      "New flash drive request: Bakery helper (Q4_K_M only), order 0a1b2c3d. 2 requests wait for an invoice: https://muse.example.com/fine-tuning/orders",
    );
    assert.doesNotMatch(text, /Ada|example\.com\b(?!\/)|Analytical|78701|Austin/);
    assert.match(ownerSummary({ title: "X", build: "all", count: 3, orderId: ORDER, waiting: 1, adminUrl: "u" }), /1 request waits/);
    // What goes on the drive says how many sizes there are, never "All three" for two.
    assert.match(ownerSummary({ title: "X", build: "all", count: 2, orderId: ORDER, waiting: 1, adminUrl: "u" }), /\(Both sizes\)/);
    assert.deepEqual([buildLabel("all", 3), buildLabel("all", 2), buildLabel("all", 1), buildLabel("Q3_K_M", 1)], ["All three sizes", "Both sizes", "Its one size", "Q3_K_M only"]);
  });
});

describe("the admin's changes and the bench's reports", () => {
  it("needs the invoice reference and amount for Invoiced, the carrier and tracking for Shipped", () => {
    assert.deepEqual(parseAdminChange({ status: "invoiced", invoiceRef: "INV-7", amountText: "$59" }), {
      ok: true,
      value: { to: "invoiced", invoiceRef: "INV-7", amountText: "$59" },
    });
    const noRef = parseAdminChange({ status: "invoiced", amountText: "$59" });
    assert.ok(!noRef.ok);
    assert.equal(noRef.error, "Add the invoice reference.");
    assert.ok(!parseAdminChange({ status: "shipped", carrier: "USPS" }).ok);
    assert.ok(parseAdminChange({ status: "shipped", carrier: "USPS", tracking: "9400 1000 0000 0000 0000 00" }).ok);
    assert.ok(!parseAdminChange({ status: "shipped", carrier: "USPS", tracking: "<script>" }).ok);
    assert.ok(parseAdminChange({ status: "paid" }).ok);
    assert.ok(!parseAdminChange({ status: "checked" }).ok, "checked comes only from the bench");
    assert.ok(!parseAdminChange({ status: "flashing" }).ok);
    assert.ok(!parseAdminChange({ status: "paid", note: "x".repeat(501) }).ok);
  });

  it("checks a bench report", () => {
    const good = { serial: "MM-0A1B2C3D4E5F", manifestSha256: "f".repeat(64), result: "PASS", imageVersion: "2026.10.28-b11669" };
    assert.deepEqual(parseBenchReport(good), { ok: true, value: good });
    assert.ok(!parseBenchReport({ ...good, result: "OK" }).ok);
    assert.ok(!parseBenchReport({ ...good, serial: "mm-1" }).ok);
    assert.ok(!parseBenchReport({ ...good, manifestSha256: "F".repeat(64) }).ok);
    const odd = parseBenchReport({ ...good, imageVersion: "a b" });
    assert.ok(odd.ok && odd.value.imageVersion === undefined);
  });
});

describe("views", () => {
  it("gives the buyer their order, and nothing once purged but the order itself", () => {
    const view = toOrderView(row({ status: "invoiced", invoicedAt: new Date(T0.getTime() + 3_600_000), invoiceRef: "INV-7" }));
    assert.equal(view.title, "Bakery helper");
    assert.equal(view.buyer?.email, "ada@example.com");
    assert.equal(view.at.requested, T0.toISOString());
    assert.ok(view.at.invoiced);
    assert.equal(view.at.paid, undefined);
    assert.equal(view.buyerCanCancel, true);
    assert.equal(JSON.stringify(view).includes("secrethash"), false, "never the secret's hash");
    assert.doesNotMatch(JSON.stringify(view), /clientkey|browserkey/, "never the quota keys");
    const purged = toOrderView(row({ status: "delivered", name: null, email: null, address: null, purgedAt: T0 }));
    assert.equal(purged.buyer, null);
    assert.equal(purged.purged, true);
    assert.equal(purged.buyerCanCancel, false);
  });

  it("gives the admin the actions the order allows, and the highlight", () => {
    const admin = toAdminRow(row(), new Date("2026-11-02T00:00:00Z"));
    assert.deepEqual(admin.actions, ["invoiced", "cancelled"]);
    assert.equal(admin.overdue, true);
    assert.deepEqual(toAdminRow(row({ status: "checked" }), T0).actions, ["shipped", "cancelled"], "the step forward first");
    assert.deepEqual(toAdminRow(row({ status: "flashing" }), T0).actions, ["cancelled"]);
    assert.deepEqual(toAdminRow(row({ status: "shipped" }), T0).actions, ["delivered"]);
  });

  it("gives the bench what to write and nothing about the buyer", () => {
    const bench = toBenchOrder(row({ status: "paid" }));
    assert.equal(bench.serial, "MM-0A1B2C3D4E5F");
    assert.equal(bench.files.length, 3);
    assert.doesNotMatch(JSON.stringify(bench), /Ada|ada@|Analytical|78701|Austin|clientkey|browserkey|secrethash/);
  });
});
