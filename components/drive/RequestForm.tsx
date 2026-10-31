"use client";

import Link from "next/link";
import { useEffect, useId, useState, type FormEvent } from "react";
import { CopyField } from "@/components/CopyButton";
import { PayButton, goToCheckout } from "@/components/drive/PayButton";
import { Icon } from "@/components/icons";
import { REMEMBER_KEY, addressLines, requestErrorText } from "@/components/drive/format";
import { DRIVE_FIELD_MAX, US_STATES, buildLabel, gb } from "@/lib/drive/logic";
import type { DriveAddress, DriveBuild } from "@/lib/drive/types";
import type { QuantLevel } from "@/lib/train/local-files";
import { buildMinimum } from "@/lib/vibe/device";

export interface RequestFormProps {
  jobId: string;
  title: string;
  /** The builds that passed their file checks, smallest first. */
  files: Array<{ level: QuantLevel; bytes: number }>;
  termsVersion: string;
  terms: readonly string[];
  /** Where buyers write about an order (DRIVE_CONTACT_EMAIL), or null. */
  contact?: string | null;
  /**
   * The card price ("$59") while orders are paid by card on Stripe Checkout, or null for a request the owner invoices.
   * With it, sending the form saves the order and goes straight to Stripe.
   */
  cardPrice?: string | null;
}

/** What "Remember my details on this device" keeps, in this browser only. */
interface Remembered {
  name: string;
  email: string;
  address: DriveAddress;
  termsVersion: string;
}

interface Sent {
  orderId: string;
  link: string;
  /** For a card order whose checkout didn't open: why, with a button to try again. */
  payProblem?: string;
  build: DriveBuild;
  name: string;
  email: string;
  address: DriveAddress;
}

const EMPTY_ADDRESS: DriveAddress = { line1: "", line2: "", city: "", state: "", postalCode: "" };

/** The banner over a form with fields to fix: it goes once every marked field is fixed. */
const FIX_FIELDS = "Fix the fields marked above, then send the request.";

/** The fields in the order the form shows them, each with the suffix of its input's id, so focus goes to the first wrong one. */
const FIELD_ORDER: ReadonlyArray<[string, string]> = [
  ["build", "build-all"],
  ["name", "name"],
  ["email", "email"],
  ["line1", "line1"],
  ["line2", "line2"],
  ["city", "city"],
  ["state", "state"],
  ["postalCode", "zip"],
  ["ageOk", "age"],
  ["terms", "terms"],
];

/** "For a Mac with 24 GB or more, or a 16 GB graphics card": the computers one size runs on, from the picker's numbers. */
function sizeFor(bytes: number): string {
  const min = buildMinimum({ bytes });
  const parts = [min.macGb ? `a Mac with ${min.macGb} GB or more` : null, min.vramGb ? `a ${min.vramGb} GB graphics card` : null].filter(Boolean);
  return parts.length ? `For ${parts.join(", or ")}.` : "For a computer with a lot of memory.";
}

/** The terms, folded under what accepts them. */
function TermsList({ terms }: { terms: readonly string[] }) {
  return (
    <details className="drive-terms">
      <summary>Read the terms</summary>
      <ul>
        {terms.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </details>
  );
}

function readRemembered(): Remembered | null {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Remembered>;
    const a = v.address;
    if (typeof v.name !== "string" || typeof v.email !== "string" || typeof v.termsVersion !== "string" || !a) return null;
    if (typeof a.line1 !== "string" || typeof a.city !== "string" || typeof a.state !== "string" || typeof a.postalCode !== "string") return null;
    return { name: v.name, email: v.email, termsVersion: v.termsVersion, address: { ...a, line2: typeof a.line2 === "string" ? a.line2 : "" } };
  } catch {
    return null;
  }
}

function writeRemembered(value: Remembered | null): void {
  try {
    if (value) window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // A private window or blocked storage: the order still went through, it just isn't remembered.
  }
}

/**
 * The order request, on one screen (docs/VIBE_TUNING.md, Feature 6): which sizes, the buyer's name, email and US
 * address, the 18+ box and the terms. "Remember my details on this device" keeps them in this browser's localStorage
 * only, so the next request is one click: the button sends it straight away and shows what it sent. Nothing is charged:
 * the owner emails an invoice. The link to the order is shown once, after the request.
 */
export function RequestForm({ jobId, title, files, termsVersion, terms, contact = null, cardPrice = null }: RequestFormProps) {
  const id = useId();
  const [remembered, setRemembered] = useState<Remembered | null>(null);
  const [editing, setEditing] = useState(false);
  const [build, setBuild] = useState<DriveBuild>(files.length > 1 ? "all" : (files[0]?.level ?? "all"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState<DriveAddress>(EMPTY_ADDRESS);
  const [ageOk, setAgeOk] = useState(false);
  const [termsOk, setTermsOk] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [focusKey, setFocusKey] = useState<{ key: string } | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);

  // Read after the first render, so the server's HTML and the browser's first render match.
  useEffect(() => {
    const saved = readRemembered();
    if (!saved) return;
    setRemembered(saved);
    setName(saved.name);
    setEmail(saved.email);
    setAddress({ ...EMPTY_ADDRESS, ...saved.address });
    setRemember(true);
  }, []);

  // After a refusal, focus goes to the first field to fix, once the full form is on the page.
  useEffect(() => {
    if (!focusKey) return;
    const suffix = FIELD_ORDER.find(([key]) => key === focusKey.key)?.[1];
    if (suffix) document.getElementById(`${id}-${suffix}`)?.focus();
  }, [focusKey, id]);

  const quick = remembered !== null && remembered.termsVersion === termsVersion && !editing;
  const allBytes = files.reduce((n, f) => n + f.bytes, 0);
  /** A field the person changed is no longer marked wrong; the banner goes with the last one. */
  const fixed = (key: string) =>
    setInvalid((all) => {
      if (!(key in all)) return all;
      const rest = { ...all };
      delete rest[key];
      return rest;
    });
  const setField = (key: keyof DriveAddress, value: string) => {
    setAddress((a) => ({ ...a, [key]: value }));
    fixed(key);
  };
  const pick = (b: DriveBuild) => {
    setBuild(b);
    fixed("build");
  };
  const shownError = error === FIX_FIELDS && !Object.keys(invalid).length ? null : error;

  async function send(details: { name: string; email: string; address: DriveAddress }, keep: boolean) {
    setBusy(true);
    setError(null);
    setInvalid({});
    const clean: DriveAddress = {
      line1: details.address.line1.trim(),
      ...(details.address.line2?.trim() ? { line2: details.address.line2.trim() } : {}),
      city: details.address.city.trim(),
      state: details.address.state,
      postalCode: details.address.postalCode.trim(),
    };
    try {
      const res = await fetch("/api/drive/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trainingJobId: jobId,
          build,
          name: details.name.trim(),
          email: details.email.trim(),
          address: clean,
          ageOk: true,
          termsVersion,
        }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (res.status !== 201) {
        const field = (data as { field?: unknown } | null)?.field;
        const text = requestErrorText(res.status, data);
        if (res.status === 400 && typeof field === "string") {
          setInvalid({ [field]: text });
          // A remembered detail the platform refused needs the full form to fix it.
          setEditing(true);
          setFocusKey({ key: field });
        }
        setError(text);
        setBusy(false);
        return;
      }
      const d = data as { orderId?: unknown; link?: unknown; payment?: unknown };
      if (typeof d.orderId !== "string" || typeof d.link !== "string") {
        setError("The request went through, but its link didn't come back. Check your email for the invoice.");
        setBusy(false);
        return;
      }
      writeRemembered(keep ? { name: details.name.trim(), email: details.email.trim(), address: clean, termsVersion } : null);
      const saved: Sent = { orderId: d.orderId, link: d.link, build, name: details.name.trim(), email: details.email.trim(), address: clean };
      if (d.payment === "card") {
        // Straight on to Stripe. The order page shows its link when the buyer comes back, and this browser keeps it.
        const problem = await goToCheckout(d.orderId);
        if (!problem) return;
        saved.payProblem = problem;
      }
      setSent(saved);
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection and try again.");
    }
    setBusy(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = "Add your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      problems.email = cardPrice ? "Check your email address. Your receipt goes there." : "Check your email address. We send the invoice there.";
    }
    if (!address.line1.trim()) problems.line1 = "Add your street address.";
    if (!address.city.trim()) problems.city = "Add your city.";
    if (!address.state) problems.state = "Pick your state.";
    if (!/^\d{5}(-?\d{4})?$/.test(address.postalCode.trim())) problems.postalCode = "Check your ZIP code: 5 digits, or 9 with the dash.";
    if (!ageOk) problems.ageOk = "Confirm that you're 18 or older.";
    if (!termsOk) problems.terms = cardPrice ? "Accept the terms to order." : "Accept the terms to send the request.";
    setInvalid(problems);
    const first = FIELD_ORDER.find(([key]) => problems[key]);
    if (first) {
      setError(FIX_FIELDS);
      setFocusKey({ key: first[0] });
      return;
    }
    void send({ name, email, address }, remember);
  }

  if (sent) {
    return (
      <section className="card section-card" aria-labelledby={`${id}-sent`} role="status">
        <h2 id={`${id}-sent`}>{sent.payProblem ? "Order saved, not paid yet" : "Request sent"}</h2>
        {sent.payProblem ? (
          <>
            <p>
              {sent.payProblem} Your order is saved and nothing was charged. Pay when you&apos;re ready, here or from your order&apos;s page.
            </p>
            <PayButton orderId={sent.orderId} label={cardPrice ? `Pay ${cardPrice} by card` : "Pay by card"} />
          </>
        ) : (
          <p>
            We&apos;ll email an invoice to <strong>{sent.email}</strong> within 2 business days. Nothing is charged until you pay it.
          </p>
        )}
        <div className="drive-link-field">
          <span className="field-label">Your order&apos;s link</span>
          <CopyField value={sent.link} label="Order link" />
          <p className="field-hint">
            Save this link now: it isn&apos;t emailed, and we can&apos;t show it again. It opens your order on any device,
            and this browser remembers the order on its own.
          </p>
        </div>
        <dl className="kv">
          <div>
            <dt>Model</dt>
            <dd>{title}</dd>
          </div>
          <div>
            <dt>On the drive</dt>
            <dd>{buildLabel(sent.build, files.length)}</dd>
          </div>
          <div>
            <dt>Ship to</dt>
            <dd>
              <address className="drive-address">
                {[sent.name, ...addressLines(sent.address)].map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </address>
            </dd>
          </div>
          <div>
            <dt>{cardPrice ? "Receipt to" : "Invoice to"}</dt>
            <dd>{sent.email}</dd>
          </div>
        </dl>
        <div className="drive-row">
          <Link className="btn btn-primary" href={`/orders/${sent.orderId}`}>
            Open your order
          </Link>
          <span className="muted small">You can cancel it there until we start writing the drive.</span>
        </div>
        {contact ? (
          <p className="muted small">
            Questions about it? Write to <a href={`mailto:${contact}`}>{contact}</a>.
          </p>
        ) : null}
      </section>
    );
  }

  const fieldProps = (key: string) => ({
    "aria-invalid": invalid[key] ? true : undefined,
    "aria-describedby": invalid[key] ? `${id}-${key}-err` : undefined,
  });
  const fieldError = (key: string) =>
    invalid[key] ? (
      <p className="train-field-error" id={`${id}-${key}-err`}>
        {invalid[key]}
      </p>
    ) : null;

  const sizes = (
    <fieldset className="drive-builds" aria-describedby={invalid.build ? `${id}-build-err` : undefined}>
      <legend className="train-label">What goes on the drive</legend>
      {files.length > 1 ? (
        <label className="drive-build">
          <input id={`${id}-build-all`} type="radio" name={`${id}-build`} value="all" checked={build === "all"} onChange={() => pick("all")} disabled={busy} />
          <span className="drive-build-text">
            <strong>{buildLabel("all", files.length)}</strong>
            <span className="muted small">On a 64 GB stick. Start picks the one your computer runs.</span>
          </span>
          <span className="drive-build-size">{gb(allBytes)}</span>
        </label>
      ) : null}
      {files.map((f) => (
        <label className="drive-build" key={f.level}>
          <input type="radio" name={`${id}-build`} value={f.level} checked={build === f.level} onChange={() => pick(f.level)} disabled={busy} />
          <span className="drive-build-text">
            <strong>{f.level} only</strong>
            <span className="muted small">{sizeFor(f.bytes)} On a 32 GB stick.</span>
          </span>
          <span className="drive-build-size">{gb(f.bytes)}</span>
        </label>
      ))}
      {fieldError("build")}
    </fieldset>
  );

  if (quick && remembered) {
    return (
      <section className="card section-card" aria-labelledby={`${id}-quick`}>
        <h2 id={`${id}-quick`}>{cardPrice ? "Order a drive" : "Request a drive"}</h2>
        {sizes}
        <div className="drive-quick">
          <p className="muted small">This device remembers your details:</p>
          <address className="drive-quick-to">
            {[remembered.name, ...addressLines(remembered.address), remembered.email].map((line) => (
              <span key={line}>{line}</span>
            ))}
          </address>
          <p className="small">
            By sending it you confirm again that you&apos;re 18 or older and accept the terms you accepted before.
          </p>
          <TermsList terms={terms} />
          <div className="drive-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void send(remembered, true)}>
              {busy ? "Sending..." : cardPrice ? `Pay ${cardPrice} by card` : "Send the request"}
            </button>
            <button type="button" className="link-btn" disabled={busy} onClick={() => setEditing(true)}>
              Change details
            </button>
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => {
                writeRemembered(null);
                setRemembered(null);
                setRemember(false);
              }}
            >
              Forget my details
            </button>
          </div>
        </div>
        {shownError ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} />
            {shownError}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section className="card section-card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{cardPrice ? "Order a drive" : "Request a drive"}</h2>
      <form className="train-form" onSubmit={submit} noValidate>
        {sizes}
        <div className="train-grid">
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-name`}>
              Name
            </label>
            <input id={`${id}-name`} className="train-input" type="text" autoComplete="name" value={name} maxLength={DRIVE_FIELD_MAX.name} onChange={(e) => {
                setName(e.target.value);
                fixed("name");
              }} disabled={busy} {...fieldProps("name")} />
            {fieldError("name")}
          </div>
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-email`}>
              Email
            </label>
            <input id={`${id}-email`} className="train-input" type="email" autoComplete="email" inputMode="email" value={email} maxLength={DRIVE_FIELD_MAX.email} onChange={(e) => {
                setEmail(e.target.value);
                fixed("email");
              }} disabled={busy} aria-invalid={invalid.email ? true : undefined} aria-describedby={[`${id}-email-help`, invalid.email ? `${id}-email-err` : null].filter(Boolean).join(" ")} />
            <p className="train-help" id={`${id}-email-help`}>
              {cardPrice ? "Stripe's receipt and our shipping news come here." : "The invoice comes here."}
            </p>
            {fieldError("email")}
          </div>
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-line1`}>
              Street address
            </label>
            <input id={`${id}-line1`} className="train-input" type="text" autoComplete="address-line1" value={address.line1} maxLength={DRIVE_FIELD_MAX.line1} onChange={(e) => setField("line1", e.target.value)} disabled={busy} {...fieldProps("line1")} />
            {fieldError("line1")}
          </div>
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-line2`}>
              Apartment, suite <span className="muted">(optional)</span>
            </label>
            <input id={`${id}-line2`} className="train-input" type="text" autoComplete="address-line2" value={address.line2 ?? ""} maxLength={DRIVE_FIELD_MAX.line2} onChange={(e) => setField("line2", e.target.value)} disabled={busy} {...fieldProps("line2")} />
            {fieldError("line2")}
          </div>
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-city`}>
              City
            </label>
            <input id={`${id}-city`} className="train-input" type="text" autoComplete="address-level2" value={address.city} maxLength={DRIVE_FIELD_MAX.city} onChange={(e) => setField("city", e.target.value)} disabled={busy} {...fieldProps("city")} />
            {fieldError("city")}
          </div>
          <div className="train-pair">
            <div className="train-field">
              <label className="train-label" htmlFor={`${id}-state`}>
                State
              </label>
              <select id={`${id}-state`} className="train-select" autoComplete="address-level1" value={address.state} onChange={(e) => setField("state", e.target.value)} disabled={busy} {...fieldProps("state")}>
                <option value="">Pick one</option>
                {US_STATES.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
              {fieldError("state")}
            </div>
            <div className="train-field">
              <label className="train-label" htmlFor={`${id}-zip`}>
                ZIP code
              </label>
              <input id={`${id}-zip`} className="train-input" type="text" autoComplete="postal-code" inputMode="numeric" value={address.postalCode} maxLength={10} onChange={(e) => setField("postalCode", e.target.value)} disabled={busy} {...fieldProps("postalCode")} />
              {fieldError("postalCode")}
            </div>
          </div>
        </div>
        <p className="train-help">We ship to US addresses only for now.</p>

        <fieldset className="drive-checks">
          <legend className="sr-only">Before you send it</legend>
          <div>
            <label className="drive-check">
              <input
                id={`${id}-age`}
                type="checkbox"
                checked={ageOk}
                onChange={(e) => {
                  setAgeOk(e.target.checked);
                  fixed("ageOk");
                }}
                disabled={busy}
                {...fieldProps("ageOk")}
              />
              <span>I&apos;m 18 or older. Meta&apos;s Usage Policy says Muse Glimmer isn&apos;t for anyone under 18.</span>
            </label>
            {fieldError("ageOk")}
          </div>
          <div>
            <label className="drive-check">
              <input
                id={`${id}-terms`}
                type="checkbox"
                checked={termsOk}
                onChange={(e) => {
                  setTermsOk(e.target.checked);
                  fixed("terms");
                }}
                disabled={busy}
                {...fieldProps("terms")}
              />
              <span>I accept the terms.</span>
            </label>
            <TermsList terms={terms} />
            {fieldError("terms")}
          </div>
          <label className="drive-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
            <span>
              Remember my details on this device. They stay in this browser only, so your next request is one click.
            </span>
          </label>
        </fieldset>

        {shownError ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} />
            {shownError}
          </p>
        ) : null}

        <div className="train-foot">
          <p className="train-cost">
            {cardPrice
              ? `${cardPrice} with US shipping. You pay by card on Stripe's checkout page next, and can cancel for a full refund until we start writing the drive.`
              : "This sends a request. Nothing is charged here: we email you an invoice first."}
          </p>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? (cardPrice ? "Saving your order..." : "Sending...") : cardPrice ? `Continue to payment (${cardPrice})` : "Send the request"}
          </button>
        </div>
      </form>
    </section>
  );
}
