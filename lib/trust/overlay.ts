/**
 * The trust overlay in a new product (template/caps/trust, docs/CAPABILITIES.md, section 7): proxy.ts for the
 * restricted-territory block and the age gate, Privacy, Terms and age pages, and the Footer with its Report link. A new
 * build gets it while any of TRUST_AGE_GATE, TRUST_LEGAL_PAGES, TRUST_GEO_BLOCK or TRUST_REPORTS is on. It isn't a cap:
 * no musemuse.caps.json, no caps step. Its check is a platform spec that runs with the smoke test.
 *
 * The platform writes two files from the brief, which the pages render, so they say what this product does:
 * musemuse.trust.json and musemuse.privacy.json. Both are kept root-owned and read-only in TRUST_RECORD_DIR, and every
 * verify and demo puts them and the overlay's platform files back. Script builders only, so they test without a sandbox.
 */
import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import type { CapId } from "@/lib/caps/ids";
import { modelLabel } from "@/lib/format";
import { CAPS_DIR, WORK_DIR } from "@/lib/sandbox/paths";
import { q } from "@/lib/sandbox/shell";
import { toolLabel } from "@/lib/tools/ids";
import { productGeoCountries } from "@/lib/trust/geo";
import { TERMS_UPDATED, TERMS_VERSION } from "@/lib/trust/terms";

export const TRUST_OVERLAY = "trust";
/** The commit applyTrustScript makes. A product with it has the trust overlay. */
export const TRUST_COMMIT = "Trust: privacy, terms, age gate, report link";
/** Root-owned, read-only: the two files the platform wrote for this product, as restore puts them back. */
export const TRUST_RECORD_DIR = `${WORK_DIR}/trust`;
export const TRUST_FILES = ["musemuse.trust.json", "musemuse.privacy.json"] as const;
/** What a build's .env.local gets with the overlay, so the age gate is off while tests run. Never deployed. */
export const TRUST_BUILD_ENV = "MUSEMUSE_BUILD=1\n";

export interface TrustFlags {
  ageGate: boolean;
  legalPages: boolean;
  geoBlock: boolean;
  geoCountries: readonly string[];
  reports: boolean;
}

export interface TrustOverlay {
  trust: Record<string, unknown>;
  privacy: Record<string, unknown>;
}

const INPUT_WORDS: Record<string, string> = {
  image: "the photos you add",
  video: "the videos you add",
  audio: "the recordings you add",
  pdf: "the PDFs you add",
};

/** What each cap keeps, for a product's privacy page (decision 13: deleted with the product, owners can delete any time). */
const CAP_KEEPS: Partial<Record<CapId, string>> = {
  data: "What you save is kept on Muse Muse's servers for this app until you or its owner delete it, or the app is removed.",
  files: "Files you upload are kept on Muse Muse's storage for this app until you or its owner delete them, or the app is removed.",
  jobs: "Scheduled runs keep their results for the app's owner until they're deleted, or the app is removed.",
  connect: "Keys the owner adds are kept encrypted and are never shown to visitors.",
};

/** musemuse.privacy.json: which models get which inputs, and what the product keeps, from its brief. */
export function productPrivacyFor(brief: Brief): Record<string, unknown> {
  const gets = ["what you type", ...[...new Set(brief.inputs.map((i) => i.kind))].map((k) => INPUT_WORDS[k] ?? `the ${k} you add`)];
  const seen = new Set<string>();
  const models = brief.capabilities
    .filter((c) => c.model !== "muse-gadget" && !seen.has(c.model) && Boolean(seen.add(c.model)))
    .map((c) => ({ id: c.model, label: modelLabel(c.model), does: sentence(c.need), gets }));
  const caps = briefCaps(brief);
  const keeps = caps.length
    ? caps.flatMap((c) => (CAP_KEEPS[c] ? [CAP_KEEPS[c]!] : []))
    : ["Nothing on a server. Anything it saves stays in your browser, and clearing the site's data removes it."];
  const tools = (brief.agent?.tools ?? []).filter((t) => t.id !== "web_search");
  const services = tools.length
    ? [
        `To use ${tools.map((t) => toolLabel(t.id)).join(", ")}, it sends what each tool needs to Composio, which runs the tool. Composio's own terms apply.`,
      ]
    : [];
  const uploads = brief.inputs.some((i) => ["image", "video", "audio", "pdf"].includes(i.kind));
  return { v: 1, models, keeps: keeps.length ? keeps : ["Nothing on a server."], services, uploads };
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** musemuse.trust.json: what this product's proxy, footer and pages do, from the flags as the build starts. */
export function productTrustFor(brief: Brief, opts: { slug: string; platformUrl: string; flags: TrustFlags }): Record<string, unknown> {
  const models = brief.capabilities.map((c) => c.model);
  return {
    v: 1,
    product: { name: brief.name, slug: opts.slug },
    termsVersion: TERMS_VERSION,
    updated: TERMS_UPDATED,
    ageGate: opts.flags.ageGate,
    legalPages: opts.flags.legalPages,
    geo: opts.flags.geoBlock ? productGeoCountries(opts.flags.geoCountries, models) : [],
    reportUrl: opts.flags.reports ? `${opts.platformUrl.replace(/\/+$/, "")}/report/${opts.slug}` : null,
  };
}

export function trustOverlayFor(brief: Brief, opts: { slug: string; platformUrl: string; flags: TrustFlags }): TrustOverlay {
  return { trust: productTrustFor(brief, opts), privacy: productPrivacyFor(brief) };
}

export const trustFileText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Puts the two files written at `from` (by sandbox.writeFiles) in TRUST_RECORD_DIR, root-owned and read-only, as the
 * caps' active.json is kept. Run with sudo.
 */
export function trustRecordScript(from: string, recordDir: string = TRUST_RECORD_DIR): string {
  const dir = q(recordDir);
  return [
    "set -e",
    `mkdir -p ${dir}`,
    `chmod u+w ${dir}`,
    ...TRUST_FILES.flatMap((f) => [`rm -f ${dir}/${f}`, `cat ${q(`${from}/${f}`)} > ${dir}/${f}`, `rm -f ${q(`${from}/${f}`)}`, `chown root:root ${dir}/${f}`, `chmod 444 ${dir}/${f}`]),
    `chown root:root ${dir}`,
    `chmod a-w ${dir}`,
  ].join("\n");
}

/**
 * Applies the trust overlay to the product in the current directory (PRODUCT_DIR): its files from CAPS_DIR/trust and
 * the two from TRUST_RECORD_DIR, committed as TRUST_COMMIT, before anything from the user is there. Runs as the default
 * user. A retry that finds the commit does nothing. It has no deps to install.
 */
export function applyTrustScript(capsDir: string = CAPS_DIR, recordDir: string = TRUST_RECORD_DIR): string {
  const files = q(`${capsDir}/${TRUST_OVERLAY}/files`);
  return [
    "set -eo pipefail",
    `if [ -n "$(git log --format=%s --grep=${q(`^${TRUST_COMMIT}$`)} -1 2>/dev/null)" ]; then exit 0; fi`,
    `[ -d ${files} ] || { echo "musemuse: the ${TRUST_OVERLAY} overlay isn't in this sandbox" >&2; exit 1; }`,
    `(cd ${files} && find . -type f) | while IFS= read -r f; do`,
    `  mkdir -p -- "$(dirname -- "$f")"`,
    `  rm -f -- "$f"`,
    `  cat ${files}/"$f" > "$f"`,
    `  git add -- "$f"`,
    "done",
    ...TRUST_FILES.flatMap((f) => [`rm -f ${f}`, `cat ${q(`${recordDir}/${f}`)} > ${f}`, `git add -- ${f}`]),
    `git diff --cached --quiet || git commit -qm ${q(TRUST_COMMIT)}`,
  ].join("\n");
}

/**
 * Before every verify and demo, in a product with the trust overlay (TRUST_COMMIT in its history): puts its platform
 * files and the two records back, so an edit can't drop the footer links, the pages or the gate, or fake the spec. Does
 * nothing, and says nothing, anywhere else, which is every product built with the trust flags off.
 */
export function restoreTrustFilesScript(capsDir: string = CAPS_DIR, recordDir: string = TRUST_RECORD_DIR): string {
  const overlay = `${capsDir}/${TRUST_OVERLAY}`;
  const list = `for(const p of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))console.log(p)`;
  return [
    `if [ -f ${q(`${overlay}/platform-files.json`)} ] && [ -f ${q(`${recordDir}/${TRUST_FILES[0]}`)} ] && [ -n "$(git log --format=%s --grep=${q(`^${TRUST_COMMIT}$`)} -1 2>/dev/null)" ]; then`,
    `  node -e ${q(list)} ${q(`${overlay}/platform-files.json`)} | while IFS= read -r p; do`,
    `    rm -rf -- "$p"`,
    `    mkdir -p -- "$(dirname -- "$p")"`,
    `    cp -R -- ${q(`${overlay}/files`)}/"$p" "$p" && chmod -R u+w "./$p" || echo "musemuse: couldn't restore $p" >&2`,
    `  done`,
    ...TRUST_FILES.map((f) => `  rm -f ${f} && cat ${q(`${recordDir}/${f}`)} > ${f} || echo "musemuse: couldn't restore ${f}" >&2`),
    `fi`,
  ].join("\n");
}

/** .env.local's extra lines with the overlay: the caps' lines, then MUSEMUSE_BUILD=1. Unchanged without it. */
export function withTrustEnv(capEnv: string | undefined, trust: boolean): string | undefined {
  return trust ? `${capEnv ?? ""}${TRUST_BUILD_ENV}` : capEnv;
}
