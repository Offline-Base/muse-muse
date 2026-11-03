/**
 * Pure rules for flash drive orders (docs/VIBE_TUNING.md, Feature 6): the status moves, the request's checks, which
 * models may be ordered, the 2-business-day highlight, the 60-day purge, the owner's one-line summary, the build a
 * machine gets, and the views the pages and the bench get. Nothing here touches the database or the network, so
 * lib/drive/__tests__/logic.test.ts covers all of it.
 */
import { noEmDashes } from "@/lib/brief/normalize";
import type { driveOrders } from "@/lib/db/schema";
import { QUANT_LEVELS, type LocalFiles, type QuantLevel } from "@/lib/train/local-files";
import type {
  DriveActor,
  DriveAddress,
  DriveBuild,
  DriveFile,
  DriveModel,
  DrivePayment,
  DriveStatus,
  VerifyResult,
} from "@/lib/drive/types";

export type DriveOrderRow = typeof driveOrders.$inferSelect;

/**
 * The drive image's version: the launchers and pages in drive/ and the pinned llama.cpp build (lib/drive/image.ts).
 * Bump it whenever either changes. An order keeps the version it was requested under, and the bench reports the one it
 * wrote.
 */
export const DRIVE_IMAGE_VERSION = "2026.10.28-b11669";

/** What the order page says about the price when DRIVE_PRICE_TEXT isn't set. */
export const DEFAULT_PRICE_LINE = "We'll email you a quote before anything is charged.";

/** The owner emails an invoice within this many business days; a request still waiting after that is highlighted. */
export const INVOICE_BUSINESS_DAYS = 2;

/**
 * The buyer's name, email and address (with the tracking number, the invoice's reference and amount, and the notes) go
 * this long after delivery or cancellation.
 */
export const BUYER_KEEP_DAYS = 60;

/**
 * An order still marked shipped this long after it shipped counts as delivered for the purge, so a parcel nobody
 * marked Delivered never keeps its buyer's details: USPS Ground Advantage takes 2 to 5 business days.
 */
export const DELIVERED_BY_DAYS = 14;

/**
 * A card order nobody pays for within this many days is cancelled by the purge. Its Checkout Sessions expired long
 * before (Stripe's default is 24 hours), so no payment can land on it afterwards.
 */
export const CARD_UNPAID_DAYS = 7;

/** The hashed client and browser keys only count toward the 24-hour quota, so they go after this long. */
export const CLIENT_KEY_KEEP_DAYS = 30;

/** Requests count toward the quotas for 24 hours. */
export const REQUEST_WINDOW_MS = 24 * 3_600_000;

const DAY_MS = 86_400_000;

// ---------- Statuses ----------

/**
 * Who may move an order from each status, to where. Every change is checked against this, so v1 needs no workflow. A
 * card order goes from requested straight to paid when Stripe says its checkout was paid.
 */
const MOVES: Record<DriveStatus, Partial<Record<DriveStatus, readonly DriveActor[]>>> = {
  requested: { invoiced: ["admin"], paid: ["checkout"], cancelled: ["buyer", "admin"] },
  invoiced: { paid: ["admin"], cancelled: ["buyer", "admin"] },
  // The bench claims a paid order. The buyer can still cancel until then.
  paid: { flashing: ["bench"], cancelled: ["buyer", "admin"] },
  // A stick that passed its check after a replug is "checked"; one that failed puts the order back in the queue.
  flashing: { checked: ["bench"], paid: ["bench"], cancelled: ["admin"] },
  checked: { shipped: ["admin"], cancelled: ["admin"] },
  shipped: { delivered: ["admin"] },
  delivered: {},
  cancelled: {},
};

export function canMove(from: DriveStatus, to: DriveStatus, actor: DriveActor): boolean {
  return MOVES[from]?.[to]?.includes(actor) ?? false;
}

/** Every status `actor` may move an order from to reach `to`, for the store's guarded updates. */
export function movableFrom(to: DriveStatus, actor: DriveActor): DriveStatus[] {
  return (Object.keys(MOVES) as DriveStatus[]).filter((from) => canMove(from, to, actor));
}

/** Where `actor` may move an order that is `from` now. */
export function nextStatuses(from: DriveStatus, actor: DriveActor): DriveStatus[] {
  return (Object.keys(MOVES[from] ?? {}) as DriveStatus[]).filter((to) => canMove(from, to, actor));
}

/** The buyer may cancel until the bench starts writing the stick. */
export function buyerCanCancel(status: DriveStatus): boolean {
  return canMove(status, "cancelled", "buyer");
}

export function isDriveStatus(value: unknown): value is DriveStatus {
  return typeof value === "string" && value in MOVES;
}

/** When the order reached its current status. */
export function statusSince(row: Pick<DriveOrderRow, "status" | "createdAt" | "invoicedAt" | "paidAt" | "flashingAt" | "checkedAt" | "shippedAt" | "deliveredAt" | "cancelledAt">): Date {
  const at: Record<DriveStatus, Date | null> = {
    requested: row.createdAt,
    invoiced: row.invoicedAt,
    paid: row.paidAt,
    flashing: row.flashingAt,
    checked: row.checkedAt,
    shipped: row.shippedAt,
    delivered: row.deliveredAt,
    cancelled: row.cancelledAt,
  };
  return at[row.status] ?? row.createdAt;
}

/** `from` plus `days` working days (Monday to Friday, in UTC), at the same time of day. */
export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const weekday = d.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return d;
}

/**
 * True for a request nobody has invoiced within INVOICE_BUSINESS_DAYS: the admin queue highlights it. A card order is
 * never overdue: it waits on its buyer's payment, not on the owner.
 */
export function invoiceOverdue(row: Pick<DriveOrderRow, "status" | "createdAt"> & { payment?: DrivePayment }, now: Date): boolean {
  if (row.payment === "card") return false;
  return row.status === "requested" && now.getTime() > addBusinessDays(row.createdAt, INVOICE_BUSINESS_DAYS).getTime();
}

/**
 * The cutoffs the purge uses: buyer details of orders delivered or cancelled before `buyer`, or shipped before
 * `shipped` and never marked delivered (DELIVERED_BY_DAYS more), client keys before `keys`, and card orders still
 * unpaid that were placed before `unpaid`, which are cancelled.
 */
export function purgeCutoffs(now: Date): { buyer: Date; shipped: Date; keys: Date; unpaid: Date } {
  return {
    buyer: new Date(now.getTime() - BUYER_KEEP_DAYS * DAY_MS),
    shipped: new Date(now.getTime() - (BUYER_KEEP_DAYS + DELIVERED_BY_DAYS) * DAY_MS),
    keys: new Date(now.getTime() - CLIENT_KEY_KEEP_DAYS * DAY_MS),
    unpaid: new Date(now.getTime() - CARD_UNPAID_DAYS * DAY_MS),
  };
}

// ---------- The request ----------

/** USPS codes the form takes: the states, DC, the territories and military mail. */
export const US_STATES: ReadonlyArray<readonly [code: string, name: string]> = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
  ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"],
  ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"],
  ["WY", "Wyoming"], ["AS", "American Samoa"], ["GU", "Guam"], ["MP", "Northern Mariana Islands"],
  ["PR", "Puerto Rico"], ["VI", "U.S. Virgin Islands"], ["AA", "Armed Forces Americas"],
  ["AE", "Armed Forces Europe"], ["AP", "Armed Forces Pacific"],
];
const STATE_CODES = new Set(US_STATES.map(([code]) => code));

/** Field limits, in characters. The form uses the same ones. */
export const DRIVE_FIELD_MAX = { name: 100, email: 200, line1: 100, line2: 100, city: 60, termsVersion: 40 } as const;

/** Control characters and the bidirectional overrides, which could disguise text in the admin queue. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export interface DriveRequest {
  trainingJobId: string;
  build: DriveBuild;
  name: string;
  email: string;
  address: DriveAddress;
  termsVersion: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; field: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One text field: trimmed, inner runs of spaces made one, and refused when it is missing (unless optional), too long, or
 * holds a control character or "<|". Returns the text, or the sentence that explains what is wrong. `whose` is "your"
 * for the buyer's fields and "the" for the admin's.
 */
function textField(
  value: unknown,
  label: string,
  max: number,
  opts: { optional?: boolean; whose?: "your" | "the" } = {},
): { value: string } | { error: string } {
  const whose = opts.whose ?? "your";
  const Whose = whose === "your" ? "Your" : "The";
  if (value === undefined || value === null || value === "") {
    return opts.optional ? { value: "" } : { error: `Add ${whose} ${label}.` };
  }
  if (typeof value !== "string") return { error: `Send ${whose} ${label} as text.` };
  if (UNSAFE_TEXT.test(value) || value.includes("<|")) return { error: `${Whose} ${label} has characters we can't print on a label.` };
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return opts.optional ? { value: "" } : { error: `Add ${whose} ${label}.` };
  if ([...text].length > max) return { error: `Keep ${whose} ${label} to ${max} characters.` };
  return { value: text };
}

export function isDriveBuild(value: unknown): value is DriveBuild {
  return value === "all" || (typeof value === "string" && (QUANT_LEVELS as readonly string[]).includes(value));
}

/** "12345" or "12345-6789", from 5 or 9 digits with or without the dash. Null for anything else. */
export function normalizeZip(value: string): string | null {
  const m = value.trim().match(/^(\d{5})(?:-?(\d{4}))?$/);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

/**
 * The body of POST /api/drive/requests, checked: the model's training job id, the build, the buyer's name, email and US
 * address, the 18+ box and the terms version they saw. The route compares that version with DRIVE_TERMS_VERSION.
 */
export function parseDriveRequest(body: Record<string, unknown>): ParseResult<DriveRequest> {
  const fail = (field: string, error: string): ParseResult<DriveRequest> => ({ ok: false, field, error });
  if (typeof body.trainingJobId !== "string" || !UUID.test(body.trainingJobId)) return fail("trainingJobId", "Pick a model to put on the drive.");
  if (!isDriveBuild(body.build)) return fail("build", "Pick which sizes go on the drive.");
  if (body.ageOk !== true) return fail("ageOk", "Confirm that you're 18 or older. The model's Usage Policy requires it.");
  if (typeof body.termsVersion !== "string" || !body.termsVersion.trim() || body.termsVersion.length > DRIVE_FIELD_MAX.termsVersion) {
    return fail("terms", "Accept the terms to send the request.");
  }

  const name = textField(body.name, "name", DRIVE_FIELD_MAX.name);
  if ("error" in name) return fail("name", name.error);
  const email = textField(body.email, "email", DRIVE_FIELD_MAX.email);
  if ("error" in email) return fail("email", email.error);
  if (!EMAIL.test(email.value)) return fail("email", "Check your email address. We send the invoice there.");

  const raw = body.address;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("line1", "Add your shipping address.");
  const a = raw as Record<string, unknown>;
  const line1 = textField(a.line1, "street address", DRIVE_FIELD_MAX.line1);
  if ("error" in line1) return fail("line1", line1.error);
  const line2 = textField(a.line2, "apartment or suite", DRIVE_FIELD_MAX.line2, { optional: true });
  if ("error" in line2) return fail("line2", line2.error);
  const city = textField(a.city, "city", DRIVE_FIELD_MAX.city);
  if ("error" in city) return fail("city", city.error);
  const state = typeof a.state === "string" ? a.state.trim().toUpperCase() : "";
  if (!STATE_CODES.has(state)) return fail("state", "Pick your state. We ship to US addresses only for now.");
  const zip = typeof a.postalCode === "string" ? normalizeZip(a.postalCode) : null;
  if (!zip) return fail("postalCode", "Check your ZIP code: 5 digits, or 9 with the dash.");

  return {
    ok: true,
    value: {
      trainingJobId: body.trainingJobId.toLowerCase(),
      build: body.build,
      name: name.value,
      email: email.value,
      address: {
        line1: line1.value,
        ...(line2.value ? { line2: line2.value } : {}),
        city: city.value,
        state,
        postalCode: zip,
      },
      termsVersion: body.termsVersion.trim(),
    },
  };
}

// ---------- Which models may be ordered ----------

/**
 * Why a model can't be ordered on a drive, as one sentence, or null when it can: orders are on, the model has a public
 * results page (judged, so the lab shows it to anyone), its GGUF repo is public at a commit, and at least one build
 * passed its file checks (localFilesFor lists only those).
 */
export function driveProblem(input: { enabled: boolean; judged: boolean; files: LocalFiles | null }): string | null {
  if (!input.enabled) return "Flash drive orders are off right now.";
  if (!input.judged) return "This model has no public results page, so it can't go on a drive.";
  if (!input.files) return "This model has no local files yet.";
  if (!input.files.public || !input.files.repo || !input.files.commit) return "This model's local files aren't public yet.";
  if (!input.files.files.length) return "None of this model's local files passed their checks.";
  // Only Meta models go on a drive (the organizers' Nov 2 ruling), and a drive's license files are Muse Glimmer's.
  if (input.files.quantBase) return "This model is on a small Llama, which isn't a Meta model, so it can't go on a drive.";
  return null;
}

/** The files a build puts on the drive, smallest first, or null when that build isn't one of them. */
export function filesForBuild(files: LocalFiles["files"], build: DriveBuild): DriveFile[] | null {
  const sorted = [...files].sort((a, b) => QUANT_LEVELS.indexOf(a.level) - QUANT_LEVELS.indexOf(b.level));
  const picked = build === "all" ? sorted : sorted.filter((f) => f.level === build);
  if (!picked.length) return null;
  return picked.map((f) => ({ level: f.level, name: f.name, bytes: f.bytes, sha256: f.sha256.toLowerCase() }));
}

/** What the order saves about the model besides its files. */
export function driveModelOf(files: LocalFiles): DriveModel {
  return {
    title: files.title,
    slug: files.slug,
    systemLine: files.systemLine,
    needsTunedTemplate: files.needsTunedTemplate,
    quantJobId: files.quantJobId,
    ...(files.sparkOpen ? { sparkOpen: true } : {}),
  };
}

const SIZE_COUNT = ["no", "one", "two", "three", "four", "five", "six"];

/**
 * What goes on the drive, in words: "Q4_K_M only" for one build, else every build the model has (`count` of them):
 * "All three sizes", "Both sizes" or "Its one size".
 */
export function buildLabel(build: DriveBuild, count: number): string {
  if (build !== "all") return `${build} only`;
  if (count <= 1) return "Its one size";
  return count === 2 ? "Both sizes" : `All ${SIZE_COUNT[count] ?? count} sizes`;
}

/** "16.9 GB", in decimal gigabytes as the Hub and the design count them. */
export function gb(bytes: number): string {
  const n = bytes / 1e9;
  return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)} GB`;
}

export function priceLine(priceText: string | null | undefined): string {
  const text = noEmDashes(priceText?.trim() ?? "");
  return text || DEFAULT_PRICE_LINE;
}

/** US cents as a price: "$59", or "$59.50" when there are cents. */
export function usd(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `$${dollars.toLocaleString("en-US")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/** The price line while drive orders are paid by card: the price, with US shipping, and when it's charged. */
export function cardPriceLine(cents: number): string {
  return `${usd(cents)} with US shipping, paid by card when you order.`;
}

// ---------- The build a machine gets ----------

/** The llama.cpp builds on the drive, one folder each under runtime/. */
export type DriveRuntime = "macos-arm64" | "windows-x64-vulkan" | "windows-x64-cpu";

/**
 * The least a computer needs for the builds on the drive, as one sentence ("a Mac with Apple silicon and 24 GB of
 * memory or more, or a Windows PC with a 16 GB graphics card or 32 GB of memory"), from the device picker's minimumSpec
 * (lib/vibe/device.ts), so the order pages and the picker never disagree.
 */
export function minimumSpecText(spec: { macGb: number | null; vramGb: number | null; ramGb: number | null }): string {
  const parts: string[] = [];
  if (spec.macGb) parts.push(`a Mac with Apple silicon and ${spec.macGb} GB of memory or more`);
  const pc = [spec.vramGb ? `a ${spec.vramGb} GB graphics card` : null, spec.ramGb ? `${spec.ramGb} GB of memory` : null].filter(Boolean);
  if (pc.length) parts.push(`a Windows PC with ${pc.join(" or ")}`);
  return parts.join(", or ");
}

// ---------- Links, secrets and keys ----------

/** The cookie that holds an order's link secret in the buyer's browser, one per order. */
export const ORDER_COOKIE_PREFIX = "mm_order_";
/** A random id for this browser, whose HMAC counts toward the per-client quota with the IP's. */
export const BROWSER_COOKIE = "mm_browser";
/** How long both cookies last. */
export const DRIVE_COOKIE_DAYS = 180;

export function orderCookieName(orderId: string): string {
  return `${ORDER_COOKIE_PREFIX}${orderId.toLowerCase()}`;
}

/** 32 random bytes in base64url. */
export function isOrderSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** The link shown once: opening it saves the secret in that browser and lands on /orders/{id}. */
export function orderLink(origin: string, orderId: string, secret: string): string {
  return `${origin.replace(/\/+$/, "")}/orders/${orderId}/open?k=${encodeURIComponent(secret)}`;
}

/** One serial per order, made from its id, so the bench and the platform agree without storing it first. */
export function serialFor(orderId: string): string {
  return `MM-${orderId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

/** The value of one cookie in a Cookie header, or null. */
export function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------- The owner's summary ----------

/**
 * The one line DRIVE_NOTIFY_URL gets for a new request: the model, the build, the order's short id and how many wait for
 * an invoice. Never the buyer's name, email or address.
 */
export function ownerSummary(input: { title: string; build: DriveBuild; count: number; orderId: string; waiting: number; adminUrl: string }): string {
  const waiting = input.waiting === 1 ? "1 request waits" : `${input.waiting} requests wait`;
  const title = noEmDashes(input.title).replace(/\s+/g, " ").trim().slice(0, 120);
  return `New flash drive request: ${title} (${buildLabel(input.build, input.count)}), order ${input.orderId.slice(0, 8)}. ${waiting} for an invoice: ${input.adminUrl}`;
}

/**
 * The one line DRIVE_NOTIFY_URL gets when a card order is paid: the model, the build, the order's short id and how many
 * paid orders wait for the bench. Never the buyer's name, email or address.
 */
export function paidSummary(input: { title: string; build: DriveBuild; count: number; orderId: string; toFlash: number; adminUrl: string }): string {
  const waiting = input.toFlash === 1 ? "1 drive waits" : `${input.toFlash} drives wait`;
  const title = noEmDashes(input.title).replace(/\s+/g, " ").trim().slice(0, 120);
  return `Flash drive order paid by card: ${title} (${buildLabel(input.build, input.count)}), order ${input.orderId.slice(0, 8)}. ${waiting} to be written: ${input.adminUrl}`;
}

// ---------- The admin's changes and the bench's reports ----------

export type AdminMove = "invoiced" | "paid" | "cancelled" | "shipped" | "delivered";

export interface AdminChange {
  to: AdminMove;
  invoiceRef?: string;
  amountText?: string;
  carrier?: string;
  tracking?: string;
  note?: string;
}

/** In the order the admin queue shows them: the step forward first, Cancel last. */
const ADMIN_MOVES: readonly AdminMove[] = ["invoiced", "paid", "shipped", "delivered", "cancelled"];

/**
 * The body of POST /api/drive/orders/{id}/status: where the admin moves the order, with the invoice reference and
 * amount for Invoiced, and the carrier and tracking number for Shipped. A note may come with any of them.
 */
export function parseAdminChange(body: Record<string, unknown>): ParseResult<AdminChange> {
  const fail = (field: string, error: string): ParseResult<AdminChange> => ({ ok: false, field, error });
  const to = body.status;
  if (typeof to !== "string" || !(ADMIN_MOVES as readonly string[]).includes(to)) return fail("status", "Pick what happened to the order.");
  const out: AdminChange = { to: to as AdminMove };
  const field = (key: "invoiceRef" | "amountText" | "carrier" | "tracking" | "note", label: string, max: number, needed: boolean) => {
    const got = textField(body[key], label, max, { optional: !needed, whose: "the" });
    if ("error" in got) return got.error;
    if (got.value) out[key] = got.value;
    return null;
  };
  const problems = [
    field("invoiceRef", "invoice reference", 100, to === "invoiced"),
    field("amountText", "amount", 100, to === "invoiced"),
    field("carrier", "carrier", 40, to === "shipped"),
    field("tracking", "tracking number", 60, to === "shipped"),
    field("note", "note", 500, false),
  ];
  const keys = ["invoiceRef", "amountText", "carrier", "tracking", "note"];
  const at = problems.findIndex(Boolean);
  if (at >= 0) return fail(keys[at], problems[at]!);
  if (out.tracking && !/^[A-Za-z0-9][A-Za-z0-9 -]{3,59}$/.test(out.tracking)) return fail("tracking", "Check the tracking number: letters, digits and dashes.");
  return { ok: true, value: out };
}

export interface BenchReport {
  serial: string;
  manifestSha256: string;
  result: VerifyResult;
  imageVersion?: string;
}

/** The body of POST /api/drive/bench/{id}/flashed. */
export function parseBenchReport(body: Record<string, unknown>): ParseResult<BenchReport> {
  const fail = (field: string, error: string): ParseResult<BenchReport> => ({ ok: false, field, error });
  if (typeof body.serial !== "string" || !/^MM-[0-9A-F]{12}$/.test(body.serial)) return fail("serial", "Send the order's serial.");
  if (typeof body.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.manifestSha256)) {
    return fail("manifestSha256", "Send the sha256 of the stick's SHA256SUMS.");
  }
  if (body.result !== "PASS" && body.result !== "FAIL") return fail("result", "Send PASS or FAIL.");
  const imageVersion =
    typeof body.imageVersion === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(body.imageVersion) ? body.imageVersion : undefined;
  return { ok: true, value: { serial: body.serial, manifestSha256: body.manifestSha256, result: body.result, ...(imageVersion ? { imageVersion } : {}) } };
}

// ---------- Views ----------

/** An order as its buyer (the link's holder) and admins see it. The buyer's details are null once purged. */
export interface DriveOrderView {
  id: string;
  status: DriveStatus;
  /** When it reached each status it has reached, ISO. */
  at: Partial<Record<DriveStatus, string>>;
  trainingJobId: string;
  title: string;
  build: DriveBuild;
  files: Array<{ level: QuantLevel; name: string; bytes: number }>;
  repo: string;
  commit: string;
  /** How the buyer pays: an emailed invoice, or by card on Stripe Checkout. */
  payment: DrivePayment;
  /** For a card order, the Stripe payment's id; for an invoice, the owner's reference. */
  invoiceRef: string | null;
  amountText: string | null;
  /** True once a card order cancelled after payment was refunded on Stripe. */
  refunded: boolean;
  carrier: string | null;
  tracking: string | null;
  serial: string | null;
  buyer: { name: string; email: string; address: DriveAddress } | null;
  purged: boolean;
  cancelledBy: DriveActor | null;
  buyerCanCancel: boolean;
}

/** A row of the admin queue: the order, plus what only the owner needs. */
export interface DriveAdminRow extends DriveOrderView {
  since: string;
  overdue: boolean;
  verifyResult: VerifyResult | null;
  manifestSha256: string | null;
  note: string | null;
  imageVersion: string;
  /** What the admin may do from here. */
  actions: AdminMove[];
}

/** What the bench gets for the order it should flash next: no buyer details at all. */
export interface BenchOrder {
  id: string;
  status: DriveStatus;
  serial: string;
  imageVersion: string;
  build: DriveBuild;
  trainingJobId: string;
  repo: string;
  commit: string;
  files: DriveFile[];
  model: DriveModel;
  /** Where the buyer writes about the drive (DRIVE_CONTACT_EMAIL), for the drive's own pages. The bench route adds it. */
  contact?: string | null;
}

function iso(d: Date | null): string | undefined {
  return d ? d.toISOString() : undefined;
}

export function toOrderView(row: DriveOrderRow): DriveOrderView {
  const at: Partial<Record<DriveStatus, string>> = {};
  const stamps: Array<[DriveStatus, Date | null]> = [
    ["requested", row.createdAt],
    ["invoiced", row.invoicedAt],
    ["paid", row.paidAt],
    ["flashing", row.flashingAt],
    ["checked", row.checkedAt],
    ["shipped", row.shippedAt],
    ["delivered", row.deliveredAt],
    ["cancelled", row.cancelledAt],
  ];
  for (const [status, when] of stamps) {
    const value = iso(when);
    if (value) at[status] = value;
  }
  const buyer =
    row.name && row.email && row.address ? { name: row.name, email: row.email, address: row.address } : null;
  return {
    id: row.id,
    status: row.status,
    at,
    trainingJobId: row.trainingJobId,
    title: row.model.title,
    build: row.build,
    files: row.files.map((f) => ({ level: f.level, name: f.name, bytes: f.bytes })),
    repo: row.ggufRepo,
    commit: row.ggufCommit,
    payment: row.payment,
    invoiceRef: row.invoiceRef,
    amountText: row.amountText,
    refunded: Boolean(row.refundRef),
    carrier: row.carrier,
    tracking: row.tracking,
    serial: row.serial,
    buyer,
    purged: Boolean(row.purgedAt),
    cancelledBy: row.cancelledBy,
    buyerCanCancel: buyerCanCancel(row.status),
  };
}

export function toAdminRow(row: DriveOrderRow, now: Date): DriveAdminRow {
  return {
    ...toOrderView(row),
    since: statusSince(row).toISOString(),
    overdue: invoiceOverdue(row, now),
    verifyResult: row.verifyResult,
    manifestSha256: row.manifestSha256,
    note: row.note,
    imageVersion: row.imageVersion,
    // A card order is paid on Stripe, so the admin never invoices it or marks it paid by hand.
    actions: ADMIN_MOVES.filter((to) => canMove(row.status, to, "admin") && !(row.payment === "card" && (to === "invoiced" || to === "paid"))),
  };
}

export function toBenchOrder(row: DriveOrderRow): BenchOrder {
  return {
    id: row.id,
    status: row.status,
    serial: row.serial ?? serialFor(row.id),
    imageVersion: row.imageVersion,
    build: row.build,
    trainingJobId: row.trainingJobId,
    repo: row.ggufRepo,
    commit: row.ggufCommit,
    files: row.files,
    model: row.model,
  };
}
