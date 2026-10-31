import type { ReactNode } from "react";
import { CopyField } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { DeviceFrame } from "@/components/product/DeviceFrame";
import type { GetItSlots } from "@/components/product/GetItPanel";
import { QrCode } from "@/components/product/QrCode";
import type { TargetId } from "@/lib/brief/schema";
import { plural } from "@/lib/format";
import { liveFrameAllow, liveFrameSandbox } from "@/lib/product-frame";
import { downloadablePackage, safeHttpUrl, type NativeCheckState, type NativeCheckView, type NativePackageView, type ProductNativeView } from "@/lib/native/product-view";
import { SHELL_UPDATE_PUBLISHED, appLink, expoGoLink } from "@/lib/native/shell-links";
import type { NativeDownload } from "@/lib/native/types";

/** What the slots need to know beyond the product's apps. */
export interface NativeSlotContext {
  slug: string;
  name: string;
  liveUrl: string | null;
  /** The platform's own address, for the links people scan and type. */
  origin: string;
  /** The brief as stored, for the frame's permissions. */
  brief: object | null;
  isOwner: boolean;
  /** The page is open in Quest Browser. */
  onQuest: boolean;
  /** The targets switched on here (env.enabledTargets). */
  enabled: readonly TargetId[];
  /** How many times each package was downloaded, for its owner. */
  downloads?: ReadonlyMap<string, number>;
}

const STATE_WORDS: Record<NativeCheckState, string> = {
  passed: "Passed",
  failed: "Didn't pass",
  checking: "Checking",
  not_checked: "Not checked",
};
const STATE_TONE: Record<NativeCheckState, string> = {
  passed: "pill-live",
  failed: "pill-failed",
  checking: "pill-building",
  not_checked: "pill-neutral",
};

/** A package's size for a download button. Rounded, as people read it: 41 MB, not 39.1. */
export function downloadSize(n: number): string {
  return `${Math.max(1, Math.round(n / 1_000_000))} MB`;
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="getit-steps">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ol>
  );
}

function Scan({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <figure className="getit-qr">
      <QrCode value={value} label={label} size={112} />
      <figcaption>{note}</figcaption>
    </figure>
  );
}

function CheckRow({ check, isOwner }: { check: NativeCheckView; isOwner: boolean }) {
  const hasMore = Boolean(check.clip || check.shots.length || check.summary || (isOwner && check.reasons.length));
  const head = (
    <span className="getit-check-text">
      <span className="getit-check-name">
        {check.label}
        {check.device ? <span className="getit-check-device"> ({check.device})</span> : null}
      </span>
      <span className="getit-check-tags">
        <span className={`pill ${STATE_TONE[check.state]}`}>
          <span className="pill-dot" aria-hidden />
          {STATE_WORDS[check.state]}
        </span>
        {check.simulated ? <span className="getit-tag">Simulated</span> : null}
      </span>
    </span>
  );
  if (!hasMore) return <li className="getit-check-row">{head}</li>;
  return (
    <li>
      <details className="getit-check">
        <summary className="getit-check-row">
          {check.clip?.posterUrl ? (
            <span className="getit-check-thumb">
              {/* A poster from storage. next/image would need every host configured. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={check.clip.posterUrl} alt="" width={72} height={40} loading="lazy" />
            </span>
          ) : null}
          {head}
          <Icon name="chevronRight" size={16} className="getit-check-chevron" />
        </summary>
        <div className="getit-check-more">
          {check.summary ? <p>{check.summary}</p> : null}
          {isOwner && check.reasons.length ? (
            <ul className="getit-reasons">
              {check.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
          {check.clip ? (
            <figure className="getit-clip">
              <video src={check.clip.url} poster={check.clip.posterUrl ?? undefined} controls preload="none" playsInline aria-label={check.clip.caption ?? `A recording on ${check.label}`} />
              {check.clip.caption ? <figcaption>{check.clip.caption}</figcaption> : null}
            </figure>
          ) : null}
          {check.shots.length ? (
            <div className="getit-shots">
              {check.shots.map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.url} alt={s.caption ?? `A screenshot on ${check.label}`} loading="lazy" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/** What a place was checked on, each result saying whether it was simulated. A failed package's check is for its owner. */
function CheckList({ checks, isOwner, none }: { checks: readonly NativeCheckView[]; isOwner: boolean; none?: string }) {
  const shown = checks.filter((c) => isOwner || !(c.state === "failed" && c.download));
  if (!shown.length) return none ? <p className="getit-note">{none}</p> : null;
  return (
    <div className="getit-checks">
      <h4>Checks</h4>
      <ul>
        {shown.map((c) => (
          <CheckRow key={c.id} check={c} isOwner={isOwner} />
        ))}
      </ul>
    </div>
  );
}

const DOWNLOAD_WORDS: Record<NativeDownload, { button: string; format: string; subject: string }> = {
  android: { button: "Download for Android", format: "APK", subject: "The Android app" },
  mac: { button: "Download for Mac", format: "zip", subject: "The Mac app" },
  windows: { button: "Download for Windows", format: "zip", subject: "The Windows app" },
};

/** The download button, or what stands in for it: still being made, nothing to offer, or held back by a failed check. */
function DownloadButton({ view, download, ctx }: { view: ProductNativeView; download: NativeDownload; ctx: NativeSlotContext }) {
  const words = DOWNLOAD_WORDS[download];
  const pack: NativePackageView | undefined = view.packages.find((p) => p.download === download);
  if (!pack) return <p className="getit-note">{view.working ? `${words.subject} is being made.` : `${words.subject} isn't ready yet.`}</p>;
  if (!downloadablePackage(view, download)) {
    return (
      <p className="getit-note">
        {ctx.isOwner ? `Only you can see this. ${words.subject} failed its check, so visitors can't download it.` : `${words.subject} isn't available right now.`}
      </p>
    );
  }
  const count = ctx.isOwner ? ctx.downloads?.get(pack.artifactId) : undefined;
  return (
    <p className="getit-get">
      <a className="btn btn-primary" href={`/p/${ctx.slug}/get/${download}`}>
        <Icon name="download" size={18} />
        <span>
          {words.button} ({words.format}, {downloadSize(pack.bytes)})
        </span>
      </a>
      {count !== undefined ? <span className="muted small">{plural(count, "download")}</span> : null}
    </p>
  );
}

/** "Not checked yet" belongs to a package that's on offer and that nothing has looked at. */
function notCheckedLine(view: ProductNativeView, download: NativeDownload): string | undefined {
  return view.packages.some((p) => p.download === download && p.state === "not_checked") ? "Not checked yet." : undefined;
}

function PhonePanel({ view, ctx }: { view: ProductNativeView; ctx: NativeSlotContext }) {
  const phoneChecks = (download: NativeDownload | null) => view.checks.filter((c) => c.target === "phone" && c.download === download);
  const android = downloadablePackage(view, "android");
  const live = ctx.liveUrl && safeHttpUrl(ctx.liveUrl) ? ctx.liveUrl : null;
  return (
    <div className="getit-tab">
      {live ? (
        <section className="getit-block">
          <h3>Try it here</h3>
          <DeviceFrame src={live} title={`${ctx.name}, the live product in a device frame`} allow={liveFrameAllow(ctx.brief)} sandbox={liveFrameSandbox(ctx.brief)} />
        </section>
      ) : null}
      <div className="getit-pair">
        <section className="getit-block">
          <h3>Android</h3>
          <DownloadButton view={view} download="android" ctx={ctx} />
          {android ? (
            <div className="getit-with-qr">
              <Steps
                items={[
                  "Open the download on your phone.",
                  "Allow installs from your browser.",
                  "Tap Install. It's not from the Play Store.",
                ]}
              />
              <Scan value={`${ctx.origin}/p/${ctx.slug}/get/android`} label="Download for Android" note="Scan it on your phone." />
            </div>
          ) : null}
          <CheckList checks={phoneChecks("android")} isOwner={ctx.isOwner} none={notCheckedLine(view, "android")} />
        </section>
        <section className="getit-block">
          <h3>iPhone</h3>
          <p className="getit-note">There&apos;s no iPhone download. Add it to your Home Screen, and it opens like an app.</p>
          {live ? (
            <div className="getit-with-qr">
              <Steps items={["Open it in Safari.", "Tap Share.", "Tap Add to Home Screen."]} />
              <Scan value={live} label="Open it in Safari" note="Scan it with your iPhone." />
            </div>
          ) : null}
          <CheckList checks={phoneChecks(null)} isOwner={ctx.isOwner} />
          {ctx.isOwner ? (
            <div className="getit-owner">
              <h4>Only you can see this</h4>
              <div className="getit-with-qr">
                <div>
                  <p className="getit-note">Open it in the phone shell with Expo Go. Scan this with your iPhone&apos;s camera.</p>
                  {SHELL_UPDATE_PUBLISHED ? null : <p className="getit-note">The shell&apos;s update isn&apos;t published yet, so this won&apos;t open until it is.</p>}
                </div>
                <Scan value={expoGoLink(ctx.slug)} label="Open in Expo Go" note="Open in Expo Go." />
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function DesktopPanel({ view, ctx }: { view: ProductNativeView; ctx: NativeSlotContext }) {
  const checks = (download: NativeDownload) => view.checks.filter((c) => c.download === download);
  return (
    <div className="getit-tab">
      <div className="getit-pair">
        <section className="getit-block">
          <h3>Mac</h3>
          <DownloadButton view={view} download="mac" ctx={ctx} />
          {downloadablePackage(view, "mac") ? (
            <Steps
              items={[
                "Unzip it and move the app to Applications.",
                "It isn't notarized by Apple, so macOS stops it the first time.",
                "Right-click the app and choose Open. On newer macOS, try to open it once, then go to System Settings, Privacy & Security, and click Open Anyway.",
              ]}
            />
          ) : null}
          <CheckList checks={checks("mac")} isOwner={ctx.isOwner} none={notCheckedLine(view, "mac")} />
        </section>
        <section className="getit-block">
          <h3>Windows</h3>
          <DownloadButton view={view} download="windows" ctx={ctx} />
          {downloadablePackage(view, "windows") ? (
            <Steps
              items={[
                "Unzip it and open the folder.",
                `Run the ${ctx.name} app inside.`,
                "SmartScreen warns about an unknown publisher. Click More info, then Run anyway.",
              ]}
            />
          ) : null}
          <CheckList checks={checks("windows")} isOwner={ctx.isOwner} none={notCheckedLine(view, "windows")} />
        </section>
      </div>
    </div>
  );
}

function QuestPanel({ ctx }: { ctx: NativeSlotContext }) {
  const host = ctx.origin.replace(/^https?:\/\//, "");
  const short = `${ctx.origin}/q/${ctx.slug}`;
  return (
    <div className="getit-tab">
      <section className="getit-block">
        <h3>Open on Quest</h3>
        {ctx.onQuest && ctx.liveUrl && safeHttpUrl(ctx.liveUrl) ? (
          <p className="getit-get">
            <a className="btn btn-primary" href={ctx.liveUrl}>
              Open in VR
            </a>
          </p>
        ) : null}
        <p className="getit-shortlink">
          {host}/q/{ctx.slug}
        </p>
        <div className="getit-with-qr">
          <div>
            <Steps items={["Open Quest Browser on your headset.", "Type the link above.", "Press Enter VR."]} />
            <CopyField value={short} label="Quest link" />
          </div>
          <Scan value={short} label="Open on a phone" note="Scan it on a phone. Phones show a 3D preview." />
        </div>
        <p className="getit-note">
          Quest can&apos;t scan a link. Bookmark <a href="/vr">{host}/vr</a> once, and pick VR products from there.
        </p>
      </section>
      <section className="getit-block">
        <h3>Without a headset</h3>
        <p className="getit-note">On a computer it opens in a simulated headset you move with the mouse and keyboard.</p>
        <p className="getit-note">Its checks ran in a simulated Meta Quest 3, not on a real headset.</p>
      </section>
    </div>
  );
}

function GlassesPanel({ view, ctx }: { view: ProductNativeView; ctx: NativeSlotContext }) {
  const checks = view.checks.filter((c) => c.target === "glasses");
  const mocked = checks.some((c) => c.state === "passed");
  return (
    <div className="getit-tab">
      <section className="getit-block">
        <h3>With Meta glasses</h3>
        <p className="getit-note">The Muse Muse iPhone app connects to your glasses. It isn&apos;t on the App Store, so most people won&apos;t have it yet.</p>
        <div className="getit-with-qr">
          <p className="getit-get">
            <a className="btn btn-primary" href={appLink(ctx.slug)}>
              Open in the iPhone app
            </a>
          </p>
          <Scan value={`${ctx.origin}/open/${ctx.slug}`} label="Open in the iPhone app" note="Scan it with your iPhone." />
        </div>
      </section>
      <section className="getit-block">
        <h3>Without glasses</h3>
        <p className="getit-note">In a browser it uses your phone&apos;s camera. With no camera it has a sample view, which uses saved photos, not a live one.</p>
        <p className="getit-note">
          {mocked
            ? "It was checked with Meta's mock glasses on an iPhone simulator, not on real glasses."
            : "Its build checks used a stand-in for the glasses and sample photos, not real glasses."}
        </p>
        <CheckList checks={checks} isOwner={ctx.isOwner} />
      </section>
    </div>
  );
}

/**
 * The "Get it" panel's slots for where a product runs. A slot is null when there's nothing to show, so with every flag off
 * and no packages the panel stays away (docs/NATIVE.md). A target's flag only decides whether to offer what isn't made yet:
 * a package that exists stays on offer whatever the flags say.
 */
export function nativeSlots(view: ProductNativeView, ctx: NativeSlotContext): GetItSlots {
  const wanted = (target: TargetId) => view.targets.includes(target) && ctx.enabled.includes(target);
  const made = (download: NativeDownload) => view.packages.some((p) => p.download === download);
  return {
    phone: wanted("phone") || made("android") ? <PhonePanel view={view} ctx={ctx} /> : null,
    desktop: wanted("desktop") || made("mac") || made("windows") ? <DesktopPanel view={view} ctx={ctx} /> : null,
    vr: wanted("vr") ? <QuestPanel ctx={ctx} /> : null,
    glasses: wanted("glasses") ? <GlassesPanel view={view} ctx={ctx} /> : null,
  };
}
