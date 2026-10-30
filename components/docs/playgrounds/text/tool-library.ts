import { hashOf } from "@/lib/docs/client/tools";

/**
 * A tool library big enough for tool search to matter (tool-search page): seven namespaces of business tools, each
 * focused and under ten functions as the page advises, with full parameter schemas (what deferral keeps out of the
 * prompt) and steady mock answers (the same order always has the same ETA). Nothing here reaches anything outside the
 * page. Actions (refunds, rollbacks, pages, invites) answer the way a real tool would on success, marked
 * `simulated: true` with a "Demo only" note: failure-shaped answers such as "not_refunded" made the model report that
 * the action had failed, which read as a broken demo.
 *
 * Function names are unique across namespaces, so a client-executed search can load them as plain functions too.
 */

type Args = Record<string, unknown>;
type Schema = Record<string, unknown>;

export interface LibraryFunction {
  name: string;
  description: string;
  parameters: Schema;
  /** Loaded up front even when the rest of its namespace is deferred (the page mixes both in one namespace). */
  alwaysLoaded?: boolean;
  /** Words a client-side search matches besides the name and description. */
  keywords?: string[];
  run(args: Args): unknown;
}

export interface LibraryNamespace {
  name: string;
  description: string;
  functions: LibraryFunction[];
}

const NOTE = "Sample data from the docs demo's mock tool.";

/** A successful action's answer, flagged as simulated: `what` says what didn't really happen. */
function simulated(status: string, what: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...fields, status, simulated: true, note: `Demo only: ${what}.` };
}

/**
 * The public holidays the demo knows: 2026 for the US (federal) and England and Wales (bank holidays), observed
 * dates. Other countries and years get an empty list that says so, rather than the wrong country's holidays.
 */
const HOLIDAYS: Readonly<Record<string, readonly string[]>> = {
  "US-2026": [
    "2026-01-01 New Year's Day",
    "2026-01-19 Martin Luther King Jr. Day",
    "2026-02-16 Washington's Birthday",
    "2026-05-25 Memorial Day",
    "2026-06-19 Juneteenth",
    "2026-07-03 Independence Day (observed)",
    "2026-09-07 Labor Day",
    "2026-10-12 Columbus Day",
    "2026-11-11 Veterans Day",
    "2026-11-26 Thanksgiving Day",
    "2026-12-25 Christmas Day",
  ],
  "GB-2026": [
    "2026-01-01 New Year's Day",
    "2026-04-03 Good Friday",
    "2026-04-06 Easter Monday",
    "2026-05-04 Early May bank holiday",
    "2026-05-25 Spring bank holiday",
    "2026-08-31 Summer bank holiday",
    "2026-12-25 Christmas Day",
    "2026-12-28 Boxing Day (substitute day)",
  ],
};

function text(args: Args, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : fallback;
}

function pick<T>(list: readonly T[], seed: string, salt = 0): T {
  return list[(hashOf(seed) >>> salt) % list.length];
}

function money(seed: string, min: number, span: number): string {
  return `$${(min + (hashOf(seed) % (span * 100)) / 100).toFixed(2)}`;
}

/** A date a few days after Oct 30, 2026 (the demo's "today"), the same one for the same seed. */
function dateAfter(seed: string, maxDays: number): string {
  const d = new Date(Date.UTC(2026, 9, 30 + 1 + (hashOf(seed) % maxDays)));
  return d.toISOString().slice(0, 10);
}

const obj = (properties: Record<string, Schema>, required: string[]): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const s = (description: string, extra: Schema = {}): Schema => ({ type: "string", description, ...extra });
const int = (description: string, extra: Schema = {}): Schema => ({ type: "integer", description, ...extra });
const bool = (description: string): Schema => ({ type: "boolean", description });

const NAMES = ["Ana Souza", "Ben Okafor", "Chloe Martin", "Dev Patel", "Emi Tanaka", "Farah Haddad", "Gus Lindqvist", "Hana Kim"];
const PLANS = ["Starter", "Team", "Business", "Enterprise"];
const ITEMS = ["Trail running shoes", "Wool socks (3 pairs)", "Insulated bottle", "Rain shell jacket", "Headlamp", "Daypack 22L"];
const CARRIERS = ["UPS", "FedEx", "USPS", "DHL"];
const SERVICES = ["checkout", "search", "auth", "payments", "notifications"];

export const TOOL_LIBRARY: readonly LibraryNamespace[] = [
  {
    name: "crm",
    description: "CRM tools for customer lookup and order management.",
    functions: [
      {
        name: "get_customer_profile",
        description: "Fetch a customer profile by customer ID.",
        alwaysLoaded: true,
        parameters: obj({ customer_id: s("The customer ID, such as CUST-12345.") }, ["customer_id"]),
        keywords: ["customer", "profile", "account", "contact"],
        run: (a) => {
          const id = text(a, "customer_id", "CUST-0");
          return { customer_id: id, name: pick(NAMES, id), plan: pick(PLANS, id, 3), email: `${pick(NAMES, id).split(" ")[0].toLowerCase()}@example.com`, customer_since: `20${18 + (hashOf(id) % 8)}`, note: NOTE };
        },
      },
      {
        name: "list_open_orders",
        description: "List open orders for a customer ID.",
        parameters: obj({ customer_id: s("The customer ID, such as CUST-12345.") }, ["customer_id"]),
        keywords: ["orders", "open", "purchases"],
        run: (a) => {
          const id = text(a, "customer_id", "CUST-0");
          const n = 1 + (hashOf(id) % 3);
          return {
            customer_id: id,
            open_orders: Array.from({ length: n }, (_, i) => ({
              order_id: `A${1000 + ((hashOf(id) >>> (i * 4)) % 9000)}`,
              item: pick(ITEMS, id, i * 3),
              status: pick(["processing", "shipped", "out for delivery"], id, i * 5),
              total: money(`${id}-${i}`, 20, 180),
            })),
            note: NOTE,
          };
        },
      },
      {
        name: "update_customer_email",
        description: "Change the email address on a customer's account.",
        parameters: obj({ customer_id: s("The customer ID."), email: s("The new email address.", { format: "email" }) }, ["customer_id", "email"]),
        keywords: ["email", "change", "update", "contact"],
        run: (a) => simulated("updated", "nothing was changed", { customer_id: text(a, "customer_id"), email: text(a, "email") }),
      },
      {
        name: "add_customer_note",
        description: "Add a note to a customer's profile, visible to staff or shared with the customer.",
        parameters: obj(
          {
            customer_id: s("The customer ID."),
            note: s("The note's text."),
            visibility: s("Who can see it.", { enum: ["internal", "shared"] }),
          },
          ["customer_id", "note", "visibility"],
        ),
        keywords: ["note", "comment", "log", "record"],
        run: (a) => ({ customer_id: text(a, "customer_id"), note_id: `NOTE-${hashOf(text(a, "note")) % 100000}`, visibility: text(a, "visibility", "internal"), status: "saved", note: NOTE }),
      },
      {
        name: "list_support_tickets",
        description: "List a customer's support tickets, open or closed.",
        parameters: obj({ customer_id: s("The customer ID."), status: s("Which tickets.", { enum: ["open", "closed", "all"] }) }, ["customer_id", "status"]),
        keywords: ["tickets", "support", "help", "issues", "complaints"],
        run: (a) => {
          const id = text(a, "customer_id", "CUST-0");
          return { customer_id: id, tickets: [{ ticket_id: `T-${hashOf(id) % 9000}`, subject: pick(["Late delivery", "Wrong size", "Billing question", "Login trouble"], id), status: "open" }], note: NOTE };
        },
      },
      {
        name: "merge_customers",
        description: "Merge a duplicate customer record into the primary one.",
        parameters: obj({ primary_id: s("The customer ID to keep."), duplicate_id: s("The customer ID to merge and remove.") }, ["primary_id", "duplicate_id"]),
        keywords: ["duplicate", "merge", "dedupe"],
        run: (a) => simulated("merged", "nothing was merged", { primary_id: text(a, "primary_id"), duplicate_id: text(a, "duplicate_id") }),
      },
    ],
  },
  {
    name: "billing",
    description: "Invoices, payments, refunds and subscriptions.",
    functions: [
      {
        name: "get_invoice",
        description: "Fetch one invoice with its line items, amount due and payment status.",
        parameters: obj({ invoice_id: s("The invoice ID, such as INV-2207.") }, ["invoice_id"]),
        keywords: ["invoice", "bill", "amount", "due"],
        run: (a) => {
          const id = text(a, "invoice_id", "INV-0");
          return { invoice_id: id, customer_id: `CUST-${10000 + (hashOf(id) % 90000)}`, amount: money(id, 30, 400), status: pick(["paid", "unpaid", "overdue"], id), due_date: dateAfter(id, 20), note: NOTE };
        },
      },
      {
        name: "list_invoices",
        description: "List a customer's invoices, filtered by payment status.",
        parameters: obj(
          { customer_id: s("The customer ID."), status: s("Which invoices.", { enum: ["paid", "unpaid", "overdue", "all"] }), limit: int("How many to return, newest first.", { minimum: 1, maximum: 50 }) },
          ["customer_id", "status", "limit"],
        ),
        keywords: ["invoices", "bills", "statements", "history"],
        run: (a) => {
          const id = text(a, "customer_id", "CUST-0");
          return { customer_id: id, invoices: [0, 1].map((i) => ({ invoice_id: `INV-${2000 + ((hashOf(id) >>> i) % 900)}`, amount: money(`${id}${i}`, 30, 300), status: i ? "paid" : pick(["unpaid", "overdue"], id) })), note: NOTE };
        },
      },
      {
        name: "issue_refund",
        description: "Refund all or part of a paid invoice to the original payment method.",
        parameters: obj(
          {
            invoice_id: s("The invoice to refund."),
            amount: { type: "number", description: "Amount in US dollars. Leave at the invoice total for a full refund.", minimum: 0.01 },
            reason: s("Why.", { enum: ["damaged", "late", "duplicate_charge", "goodwill", "other"] }),
            notify_customer: bool("Email the customer a receipt."),
          },
          ["invoice_id", "amount", "reason", "notify_customer"],
        ),
        keywords: ["refund", "money back", "reimburse", "credit"],
        run: (a) =>
          simulated("refunded", "no money moved", {
            refund_id: `RF-${hashOf(`${text(a, "invoice_id")}-${String(a.amount)}`) % 100000}`,
            invoice_id: text(a, "invoice_id"),
            amount: a.amount ?? null,
            reason: text(a, "reason", "other"),
          }),
      },
      {
        name: "update_payment_method",
        description: "Replace the card on file for a customer.",
        parameters: obj(
          { customer_id: s("The customer ID."), card_last4: s("The new card's last four digits.", { pattern: "^[0-9]{4}$" }), expires: s("Expiry as MM/YY.", { pattern: "^(0[1-9]|1[0-2])/[0-9]{2}$" }) },
          ["customer_id", "card_last4", "expires"],
        ),
        keywords: ["card", "payment", "credit card", "billing details"],
        run: (a) => simulated("updated", "no card was changed", { customer_id: text(a, "customer_id"), card_last4: text(a, "card_last4") }),
      },
      {
        name: "cancel_subscription",
        description: "Cancel a subscription now or at the end of the billing period.",
        parameters: obj(
          { subscription_id: s("The subscription ID, such as SUB-889."), at_period_end: bool("Keep it running until the period ends."), reason: s("The customer's reason, in their words.") },
          ["subscription_id", "at_period_end", "reason"],
        ),
        keywords: ["cancel", "subscription", "plan", "stop"],
        run: (a) => simulated(a.at_period_end === true ? "cancels_at_period_end" : "cancelled", "nothing was cancelled", { subscription_id: text(a, "subscription_id") }),
      },
      {
        name: "apply_discount_code",
        description: "Apply a discount code to a customer's next invoice.",
        parameters: obj({ customer_id: s("The customer ID."), code: s("The discount code.") }, ["customer_id", "code"]),
        keywords: ["discount", "coupon", "promo", "code"],
        run: (a) => ({ customer_id: text(a, "customer_id"), code: text(a, "code"), discount: `${5 + (hashOf(text(a, "code")) % 4) * 5}%`, status: "valid", note: NOTE }),
      },
    ],
  },
  {
    name: "shipping",
    description: "Shipments, carriers, delivery estimates and returns.",
    functions: [
      {
        name: "get_shipping_eta",
        description: "Look up shipping ETA details for an order.",
        parameters: obj({ order_id: s("The order ID, such as order_42 or A1042.") }, ["order_id"]),
        keywords: ["eta", "arrive", "arrival", "delivery date", "when"],
        run: (a) => {
          const id = text(a, "order_id", "order_0");
          return { order_id: id, carrier: pick(CARRIERS, id), status: pick(["label created", "in transit", "out for delivery"], id, 2), eta: dateAfter(id, 6), note: NOTE };
        },
      },
      {
        name: "track_package",
        description: "Track a package by its carrier tracking number.",
        parameters: obj(
          { tracking_number: s("The carrier's tracking number."), carrier: s("The carrier.", { enum: ["ups", "fedex", "usps", "dhl"] }) },
          ["tracking_number", "carrier"],
        ),
        keywords: ["track", "tracking", "package", "parcel", "where"],
        run: (a) => {
          const id = text(a, "tracking_number", "1Z0");
          return { tracking_number: id, last_scan: pick(["Portland, OR", "Memphis, TN", "Louisville, KY", "Ontario, CA"], id), status: "in transit", note: NOTE };
        },
      },
      {
        name: "create_return_label",
        description: "Create a prepaid return label for items from an order.",
        parameters: obj(
          {
            order_id: s("The order the items came from."),
            items: { type: "array", description: "What's coming back.", items: obj({ sku: s("The item's SKU."), quantity: int("How many.", { minimum: 1 }) }, ["sku", "quantity"]) },
            reason: s("Why it's coming back.", { enum: ["wrong_size", "damaged", "not_as_described", "changed_mind"] }),
          },
          ["order_id", "items", "reason"],
        ),
        keywords: ["return", "label", "send back", "exchange"],
        run: (a) => simulated("created", "no label was made", { order_id: text(a, "order_id"), label_url: "https://example.com/labels/demo.pdf" }),
      },
      {
        name: "change_delivery_address",
        description: "Change where an order that hasn't shipped yet is delivered.",
        parameters: obj(
          {
            order_id: s("The order ID."),
            address: obj(
              { line1: s("Street and number."), line2: s("Apartment or unit, or empty."), city: s("City."), region: s("State or region."), postal_code: s("Postal code."), country: s("Two-letter country code.", { pattern: "^[A-Z]{2}$" }) },
              ["line1", "line2", "city", "region", "postal_code", "country"],
            ),
          },
          ["order_id", "address"],
        ),
        keywords: ["address", "deliver to", "redirect", "move"],
        run: (a) => simulated("updated", "nothing was changed", { order_id: text(a, "order_id") }),
      },
      {
        name: "schedule_pickup",
        description: "Book a carrier pickup for a return.",
        parameters: obj(
          { order_id: s("The order ID."), date: s("Pickup date, YYYY-MM-DD.", { format: "date" }), window: s("Time of day.", { enum: ["morning", "afternoon"] }) },
          ["order_id", "date", "window"],
        ),
        keywords: ["pickup", "collect", "courier"],
        run: (a) => simulated("booked", "no pickup was booked", { order_id: text(a, "order_id"), date: text(a, "date"), window: text(a, "window") }),
      },
    ],
  },
  {
    name: "calendar",
    description: "Meetings, availability and reminders for the team.",
    functions: [
      {
        name: "find_free_slots",
        description: "Find times when everyone listed is free.",
        parameters: obj(
          {
            attendees: { type: "array", description: "Names or emails.", items: s("A name or email.") },
            duration_minutes: int("Meeting length.", { minimum: 15, maximum: 240 }),
            day: s("The day to search, YYYY-MM-DD.", { format: "date" }),
          },
          ["attendees", "duration_minutes", "day"],
        ),
        keywords: ["free", "available", "availability", "slot", "time"],
        run: (a) => {
          const day = text(a, "day", "2026-10-31");
          return { day, slots: [`${day}T14:00`, `${day}T15:30`, `${day}T16:00`].slice(0, 1 + (hashOf(day) % 3)), note: NOTE };
        },
      },
      {
        name: "create_event",
        description: "Put a meeting on the calendar and invite people.",
        parameters: obj(
          {
            title: s("The meeting's title."),
            start: s("Start time, ISO 8601.", { format: "date-time" }),
            duration_minutes: int("Length in minutes.", { minimum: 5 }),
            attendees: { type: "array", description: "Names or emails.", items: s("A name or email.") },
          },
          ["title", "start", "duration_minutes", "attendees"],
        ),
        keywords: ["book", "schedule", "meeting", "invite"],
        run: (a) => simulated("created", "no invite went out", { event_id: `EVT-${hashOf(text(a, "title")) % 100000}`, title: text(a, "title"), start: text(a, "start") }),
      },
      {
        name: "cancel_event",
        description: "Cancel a meeting and optionally tell the attendees.",
        parameters: obj({ event_id: s("The event ID."), notify: bool("Email the attendees.") }, ["event_id", "notify"]),
        keywords: ["cancel", "call off", "meeting"],
        run: (a) => simulated("cancelled", "nothing was cancelled", { event_id: text(a, "event_id") }),
      },
      {
        name: "list_events",
        description: "List the meetings on one day.",
        parameters: obj({ day: s("YYYY-MM-DD.", { format: "date" }) }, ["day"]),
        keywords: ["agenda", "schedule", "meetings", "today"],
        run: (a) => ({ day: text(a, "day"), events: [{ title: "Weekly sync", start: "10:00" }, { title: "Design review", start: "14:00" }], note: NOTE }),
      },
      {
        name: "set_reminder",
        description: "Set a reminder before a meeting.",
        parameters: obj({ event_id: s("The event ID."), minutes_before: int("How long before.", { minimum: 1, maximum: 1440 }) }, ["event_id", "minutes_before"]),
        keywords: ["remind", "reminder", "alert"],
        run: (a) => ({ event_id: text(a, "event_id"), minutes_before: a.minutes_before ?? null, status: "set", note: NOTE }),
      },
    ],
  },
  {
    name: "hr",
    description: "Employee directory, time off and payroll.",
    functions: [
      {
        name: "lookup_employee",
        description: "Find an employee by name or email: their ID, team and manager.",
        parameters: obj({ name_or_email: s("A name or work email.") }, ["name_or_email"]),
        keywords: ["employee", "colleague", "directory", "who"],
        run: (a) => {
          const q = text(a, "name_or_email", "someone");
          return { employee_id: `E-${1000 + (hashOf(q) % 9000)}`, name: q, team: pick(["Platform", "Growth", "Support", "Design"], q), manager: pick(NAMES, q, 4), note: NOTE };
        },
      },
      {
        name: "get_time_off_balance",
        description: "How many vacation, sick and personal days an employee has left this year.",
        parameters: obj({ employee_id: s("The employee ID, such as E-1042, or 'me'.") }, ["employee_id"]),
        keywords: ["vacation", "pto", "days off", "leave", "balance", "holiday"],
        run: (a) => {
          const id = text(a, "employee_id", "me");
          return { employee_id: id, vacation_days: 4 + (hashOf(id) % 12), sick_days: 3 + (hashOf(id) % 5), personal_days: 1 + (hashOf(id) % 3), note: NOTE };
        },
      },
      {
        name: "request_time_off",
        description: "Ask for time off for some dates.",
        parameters: obj(
          { employee_id: s("The employee ID, or 'me'."), start_date: s("First day off, YYYY-MM-DD.", { format: "date" }), end_date: s("Last day off, YYYY-MM-DD.", { format: "date" }), type: s("Kind of leave.", { enum: ["vacation", "sick", "personal"] }) },
          ["employee_id", "start_date", "end_date", "type"],
        ),
        keywords: ["request", "book leave", "vacation", "time off"],
        run: (a) => simulated("submitted", "no request was filed", { request_id: `PTO-${hashOf(text(a, "start_date")) % 10000}` }),
      },
      {
        name: "list_holidays",
        description: "Public holidays for a country and year.",
        parameters: obj({ country: s("Two-letter country code.", { pattern: "^[A-Z]{2}$" }), year: int("The year.", { minimum: 2000, maximum: 2100 }) }, ["country", "year"]),
        keywords: ["holidays", "public holiday", "bank holiday"],
        run: (a) => {
          const country = text(a, "country", "US").toUpperCase();
          const year = Number(a.year) || 2026;
          const holidays = HOLIDAYS[`${country}-${year}`];
          return holidays
            ? { country, year, holidays, note: NOTE }
            : { country, year, holidays: [], note: "The demo's sample data has public holidays for 2026 in US and GB only." };
        },
      },
      {
        name: "get_payslip",
        description: "An employee's payslip for one month.",
        parameters: obj({ employee_id: s("The employee ID, or 'me'."), month: s("YYYY-MM.", { pattern: "^[0-9]{4}-[0-9]{2}$" }) }, ["employee_id", "month"]),
        keywords: ["pay", "salary", "payslip", "payroll"],
        run: (a) => ({ employee_id: text(a, "employee_id", "me"), month: text(a, "month"), net_pay: money(text(a, "month"), 3000, 4000), note: NOTE }),
      },
    ],
  },
  {
    name: "analytics",
    description: "Sales, traffic and product reports.",
    functions: [
      {
        name: "run_sales_report",
        description: "Total sales for a date range, grouped by day, week, month, region or product.",
        parameters: obj(
          { start_date: s("YYYY-MM-DD.", { format: "date" }), end_date: s("YYYY-MM-DD.", { format: "date" }), group_by: s("How to group.", { enum: ["day", "week", "month", "region", "product"] }) },
          ["start_date", "end_date", "group_by"],
        ),
        keywords: ["sales", "revenue", "report"],
        run: (a) => ({ start_date: text(a, "start_date"), end_date: text(a, "end_date"), total: money(text(a, "start_date") + text(a, "end_date"), 40000, 90000), note: NOTE }),
      },
      {
        name: "get_active_users",
        description: "Daily, weekly or monthly active users on a date.",
        parameters: obj({ date: s("YYYY-MM-DD.", { format: "date" }), granularity: s("Which count.", { enum: ["daily", "weekly", "monthly"] }) }, ["date", "granularity"]),
        keywords: ["users", "dau", "mau", "traffic", "active"],
        run: (a) => ({ date: text(a, "date"), granularity: text(a, "granularity", "daily"), active_users: 12000 + (hashOf(text(a, "date")) % 9000), note: NOTE }),
      },
      {
        name: "compare_periods",
        description: "Compare a metric between two date ranges.",
        parameters: obj(
          {
            metric: s("The metric.", { enum: ["revenue", "orders", "active_users", "conversion_rate"] }),
            period_a: obj({ start: s("YYYY-MM-DD."), end: s("YYYY-MM-DD.") }, ["start", "end"]),
            period_b: obj({ start: s("YYYY-MM-DD."), end: s("YYYY-MM-DD.") }, ["start", "end"]),
          },
          ["metric", "period_a", "period_b"],
        ),
        keywords: ["compare", "versus", "change", "growth"],
        run: (a) => ({ metric: text(a, "metric"), change: `${(hashOf(text(a, "metric")) % 30) - 10}%`, note: NOTE }),
      },
      {
        name: "top_products",
        description: "Best-selling products in a date range.",
        parameters: obj({ start_date: s("YYYY-MM-DD."), end_date: s("YYYY-MM-DD."), limit: int("How many.", { minimum: 1, maximum: 20 }) }, ["start_date", "end_date", "limit"]),
        keywords: ["best sellers", "top", "products", "popular"],
        run: (a) => ({ products: ITEMS.slice(0, Math.min(5, Number(a.limit) || 3)), note: NOTE }),
      },
      {
        name: "export_report_csv",
        description: "Export a saved report as a CSV download link.",
        parameters: obj({ report_id: s("The saved report's ID.") }, ["report_id"]),
        keywords: ["export", "csv", "download", "spreadsheet"],
        run: (a) => ({ report_id: text(a, "report_id"), url: "https://example.com/reports/demo.csv", note: NOTE }),
      },
    ],
  },
  {
    name: "devops",
    description: "Deployments, incidents, logs and on-call.",
    functions: [
      {
        name: "list_deployments",
        description: "Recent deployments of a service, newest first.",
        parameters: obj({ service: s("The service name.", { enum: SERVICES }), limit: int("How many.", { minimum: 1, maximum: 20 }) }, ["service", "limit"]),
        keywords: ["deploy", "deployments", "release", "version"],
        run: (a) => {
          const svc = text(a, "service", "checkout");
          return { service: svc, deployments: [0, 1, 2].map((i) => ({ deployment_id: `dep_${(hashOf(svc) >>> i) % 100000}`, version: `v2.${14 - i}.0`, status: i ? "superseded" : "live" })), note: NOTE };
        },
      },
      {
        name: "rollback_deployment",
        description: "Roll a service back to an earlier deployment.",
        parameters: obj({ service: s("The service name.", { enum: SERVICES }), deployment_id: s("The deployment to roll back to."), reason: s("Why, for the audit log.") }, ["service", "deployment_id", "reason"]),
        keywords: ["rollback", "roll back", "revert", "undo deploy"],
        run: (a) => simulated("rolled_back", "nothing was rolled back", { service: text(a, "service"), deployment_id: text(a, "deployment_id") }),
      },
      {
        name: "get_incident",
        description: "An incident's status, impact and timeline.",
        parameters: obj({ incident_id: s("The incident ID, such as INC-311.") }, ["incident_id"]),
        keywords: ["incident", "outage", "status page"],
        run: (a) => ({ incident_id: text(a, "incident_id"), status: "monitoring", impact: "Elevated checkout errors in eu-west", note: NOTE }),
      },
      {
        name: "search_logs",
        description: "Search a service's logs for recent lines that match.",
        parameters: obj({ service: s("The service name.", { enum: SERVICES }), query: s("Text or a field filter."), since_minutes: int("How far back.", { minimum: 1, maximum: 1440 }) }, ["service", "query", "since_minutes"]),
        keywords: ["logs", "errors", "grep", "trace"],
        run: (a) => ({ service: text(a, "service"), matches: 3 + (hashOf(text(a, "query")) % 40), sample: "ERROR timeout calling payments after 2000 ms", note: NOTE }),
      },
      {
        name: "page_on_call",
        description: "Page the engineer on call for a team.",
        parameters: obj({ team: s("The team.", { enum: ["platform", "payments", "growth"] }), message: s("What's wrong."), severity: s("How bad.", { enum: ["low", "high", "critical"] }) }, ["team", "message", "severity"]),
        keywords: ["page", "on call", "alert", "escalate", "wake up"],
        run: (a) => simulated("paged", "nobody was paged", { team: text(a, "team"), on_call: pick(NAMES, text(a, "team")) }),
      },
    ],
  },
];

export const LIBRARY_NAMESPACES = TOOL_LIBRARY.map((n) => n.name);

export function namespacesOf(names?: readonly string[]): LibraryNamespace[] {
  if (!names?.length) return [...TOOL_LIBRARY];
  const wanted = new Set(names);
  return TOOL_LIBRARY.filter((n) => wanted.has(n.name));
}

/** A function as the Responses API takes it, deferred or not. */
export function functionTool(fn: LibraryFunction, defer: boolean): Record<string, unknown> {
  return { type: "function", name: fn.name, description: fn.description, ...(defer ? { defer_loading: true } : {}), parameters: fn.parameters };
}

export interface LibraryShape {
  namespaces: number;
  functions: number;
  deferred: number;
}

export function libraryShape(namespaces: readonly LibraryNamespace[], keepLoaded: boolean): LibraryShape {
  const functions = namespaces.reduce((n, ns) => n + ns.functions.length, 0);
  const loaded = keepLoaded ? namespaces.reduce((n, ns) => n + ns.functions.filter((f) => f.alwaysLoaded).length, 0) : 0;
  return { namespaces: namespaces.length, functions, deferred: functions - loaded };
}

/**
 * Hosted tool search's tools: each namespace with its functions deferred (`defer_loading` on the functions inside,
 * never on the namespace, as the page says), the always-loaded ones left callable when `keepLoaded`, then the one
 * `tool_search` tool.
 */
export function hostedTools(namespaces: readonly LibraryNamespace[], keepLoaded: boolean): Record<string, unknown>[] {
  return [
    ...namespaces.map((ns) => ({
      type: "namespace",
      name: ns.name,
      description: ns.description,
      tools: ns.functions.map((fn) => functionTool(fn, !(keepLoaded && fn.alwaysLoaded))),
    })),
    { type: "tool_search" },
  ];
}

/** The same library with every schema loaded up front and no tool search, for the token comparison. */
export function loadedTools(namespaces: readonly LibraryNamespace[]): Record<string, unknown>[] {
  return namespaces.map((ns) => ({ type: "namespace", name: ns.name, description: ns.description, tools: ns.functions.map((fn) => functionTool(fn, false)) }));
}

/** The client-executed tool_search tool from the page: the app runs the search, with these arguments. */
export const CLIENT_SEARCH_TOOL: Record<string, unknown> = {
  type: "tool_search",
  execution: "client",
  description: "Find the project-specific tools needed to continue the task.",
  parameters: {
    type: "object",
    properties: { goal: { type: "string" } },
    required: ["goal"],
    additionalProperties: false,
  },
};

export interface SearchHit {
  namespace: string;
  fn: LibraryFunction;
  score: number;
}

const STOP = new Set(["the", "and", "for", "then", "use", "tool", "tools", "find", "with", "that", "this", "from", "into", "what", "when", "how", "can", "you", "please", "need", "needed", "using", "get", "look", "lookup", "details"]);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * The search a client-executed app runs on the model's `goal` (tool-search, "Client-executed tool search"): shared
 * words with each function's name, description and keywords, the name counting most. A real app would search its
 * own registry, with what the tenant has enabled.
 */
export function searchLibrary(goal: string, namespaces: readonly LibraryNamespace[], limit = 3): SearchHit[] {
  const q = words(goal);
  if (!q.length) return [];
  const hits: SearchHit[] = [];
  for (const ns of namespaces) {
    for (const fn of ns.functions) {
      const name = fn.name.toLowerCase().split("_");
      const desc = words(fn.description);
      const keys = (fn.keywords ?? []).flatMap((k) => words(k));
      let score = 0;
      for (const w of q) {
        if (name.includes(w)) score += 3;
        else if (name.some((n) => n.length > 3 && (n.startsWith(w) || w.startsWith(n)))) score += 2;
        if (keys.includes(w)) score += 2;
        if (desc.includes(w)) score += 1;
        if (w === ns.name) score += 1;
      }
      if (score > 0) hits.push({ namespace: ns.name, fn, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.fn.name.localeCompare(b.fn.name)).slice(0, limit);
}

/**
 * The library function a model's call names. Hosted tool search calls a namespaced function "crm.list_open_orders"
 * (the page's example shows `name` plus a separate `namespace` field instead, so both are read); after a
 * client-executed load the model was seen calling "tool_get_shipping_eta", so a known prefix is tolerated too.
 */
export function findFunction(name: string, namespace?: string | null): { namespace: string; fn: LibraryFunction } | null {
  const clean = name.trim();
  const tries: Array<[string | null, string]> = [];
  if (namespace) tries.push([namespace, clean]);
  const dot = clean.indexOf(".");
  if (dot > 0) tries.push([clean.slice(0, dot), clean.slice(dot + 1)]);
  tries.push([null, clean]);
  for (const prefix of ["tool_", "tools_", "functions_", "functions."]) if (clean.startsWith(prefix)) tries.push([null, clean.slice(prefix.length)]);
  for (const [ns, fnName] of tries) {
    for (const lib of TOOL_LIBRARY) {
      if (ns && lib.name !== ns) continue;
      const fn = lib.functions.find((f) => f.name === fnName);
      if (fn) return { namespace: lib.name, fn };
    }
  }
  return null;
}

/** Runs a library function on the arguments the model sent: the text the app sends back as function_call_output. */
export function runLibraryCall(name: string, namespace: string | null, argumentsJson: string): { ok: boolean; output: string; value: unknown; matched: string | null } {
  if (name.trim() === "tool_search") {
    // Seen on the live API: after a client-executed load the model sometimes calls tool_search as a function.
    const value = { error: "tool_search isn't a function here. The tools this app found are already loaded: call one of them by name." };
    return { ok: false, output: JSON.stringify(value), value, matched: null };
  }
  const found = findFunction(name, namespace);
  if (!found) {
    const value = { error: `There is no tool named "${name}" in this library.` };
    return { ok: false, output: JSON.stringify(value), value, matched: null };
  }
  let args: Args = {};
  if (argumentsJson.trim()) {
    try {
      const parsed = JSON.parse(argumentsJson) as unknown;
      args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Args) : {};
    } catch {
      const value = { error: "The arguments weren't valid JSON." };
      return { ok: false, output: JSON.stringify(value), value, matched: `${found.namespace}.${found.fn.name}` };
    }
  }
  const value = found.fn.run(args);
  return { ok: true, output: JSON.stringify(value), value, matched: `${found.namespace}.${found.fn.name}` };
}
