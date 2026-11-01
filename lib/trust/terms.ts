/**
 * The platform's Terms and Privacy pages (TRUST_LEGAL_PAGES, docs/CAPABILITIES.md, section 7).
 *
 * DRAFT. This text is a plain-language draft written for the Muse Muse owner and their counsel to review and change
 * before it is relied on. It is not legal advice, and nobody should treat it as such. It describes what the code does
 * as of TERMS_VERSION; when the code changes what it collects or keeps, change this text and TERMS_VERSION together, and
 * signed-in builders are asked to accept again.
 */

/** Bump when the Terms or Privacy text changes in a way people must accept again. Sign-in asks again for a new one. */
export const TERMS_VERSION = "2026-10-31";

/** How the pages show the date. */
export const TERMS_UPDATED = "October 31, 2026";

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export const TERMS_SECTIONS: readonly LegalSection[] = [
  {
    heading: "What Muse Muse is",
    paragraphs: [
      "Muse Muse turns a note, photos, sketches or other examples into a working web product, tested and published at its own link. It is a concept project. It is built on Meta's models, and it is not an official Meta product.",
    ],
  },
  {
    heading: "Who can use it",
    bullets: [
      "You must be 18 or older to build on Muse Muse or to use a product made with it.",
      "You can't use Muse Muse, or make a product available to people, in a country or region where Meta's terms don't allow its models to be used.",
      "Building needs the access code the Muse Muse team shared with you, or the shared guest account when the team turns it on.",
    ],
  },
  {
    heading: "What you can't build",
    paragraphs: ["Muse Muse refuses, and may take down, anything that:"],
    bullets: [
      "breaks the law, or helps someone else break it",
      "impersonates a real person or organization, or copies a real brand or product",
      "collects passwords or payment details under false pretenses, or watches people without their consent",
      "contains sexual content, weapons, malware or scams, or targets a specific private person",
      "breaks Meta's terms for its models or Meta's Acceptable Use Policy",
    ],
  },
  {
    heading: "Your products",
    bullets: [
      "Products are public. Anyone with the link can open them, and they may appear in the gallery.",
      "What a product says or makes comes from AI models. It can be wrong, incomplete or out of date. Check anything that matters before you rely on it.",
      "Each product has a small daily budget for model calls. When it runs out, the product stops working until the next day (00:00 UTC).",
      "You are responsible for what you ask Muse Muse to build and for how your product is used.",
    ],
  },
  {
    heading: "Reports, takedowns and bans",
    bullets: [
      "Anyone can report a product with the Report link on it. The Muse Muse team reviews reports.",
      "The team may take a product down, or stop an account from signing in and building, when it breaks these terms. A takedown can be undone.",
    ],
  },
  {
    heading: "No promises",
    paragraphs: [
      "Muse Muse is offered as it is, for trying ideas out. It may change, pause or stop at any time, and products may stop working. To the extent the law allows, the Muse Muse team isn't responsible for losses that come from using it.",
    ],
  },
  {
    heading: "Changes",
    paragraphs: [
      "When these terms change, the date above changes, and signed-in builders are asked to accept them again before they build.",
    ],
  },
];

/**
 * What goes to Muse Spark 1.3 Contributor, the tier Meta may train on (Meta terms 6.2). Test builds use made-up data. A
 * change to a product first built on Muse Spark 1.3 resumes Muse Code on Contributor (refineBuildModel in
 * lib/pipeline/logic.ts), whatever the flags say. Until TRUST_SPARK_TO_WONDER is on, those products' own calls run there
 * too (lib/gateway/handler.ts), so what their visitors type goes there.
 */
function contributorSection(sparkToWonder: boolean, buildsOnContributor: boolean): LegalSection {
  return {
    heading: "A lower-cost Meta model",
    paragraphs: ["Some work runs on Muse Spark 1.3 Contributor, a lower-cost Meta model that Meta may use to improve its models:"],
    bullets: [
      ...(buildsOnContributor
        ? ["Every build right now. Your note, the files you add, your change requests and answers, and the product's code and test runs go to this model, so don't include personal, sensitive or confidential information. Once a product is live, its own calls run on Muse Wonder."]
        : []),
      "Test builds the Muse Muse team runs. They use made-up data only.",
      "Changes to a product first built on Muse Spark 1.3. A change carries on with the model that built the product, so your change request and the product's code go to this model.",
      ...(sparkToWonder ? [] : ["Products first built on Muse Spark 1.3 also run on it, so what people type into those products, and the files they add, go to this model."]),
    ],
  };
}

/** The platform's Privacy page, which says what TRUST_SPARK_TO_WONDER and BUILDS_ON_CONTRIBUTOR do to the model tier Meta may train on. */
export function privacySections(opts: { sparkToWonder: boolean; buildsOnContributor?: boolean }): readonly LegalSection[] {
  return PRIVACY_BASE.flatMap((s) => (s === CONTRIBUTOR_SLOT ? [contributorSection(opts.sparkToWonder, opts.buildsOnContributor === true)] : [s]));
}

/** Where the Contributor section goes in the Privacy page. */
const CONTRIBUTOR_SLOT: LegalSection = { heading: "" };

const PRIVACY_BASE: readonly LegalSection[] = [
  {
    heading: "What we keep when you build",
    bullets: [
      "Your email address, and your password as a scrypt hash (never the password itself). Signing in sets a cookie that keeps you signed in for 14 days.",
      "The notes, photos, sketches, recordings and files you give Muse Muse, the brief written from them, the build's log, screenshots and demo video, and the product's code.",
      "When you confirmed you're 18 or older and which version of the terms you accepted.",
      "What each build and product spent on model calls, for budgets and the usage page.",
    ],
  },
  {
    heading: "Who else sees it",
    bullets: [
      "Meta: your notes and files, and what people type into products, go to Meta's Model API to write the brief, build the product and run it. Meta's own terms and privacy policy apply to what it receives.",
      "Vercel hosts Muse Muse, its files and the products. Neon hosts its database.",
      "Products that use connected tools send what the tool needs to Composio, which runs those tools.",
      "Product pages and the gallery are public: a product's name, what it does, its demo and how it was built can be seen by anyone.",
    ],
  },
  CONTRIBUTOR_SLOT,
  {
    heading: "Addresses and limits",
    paragraphs: [
      "Your IP address is used to limit how often sign-in, builds and products are used, and those counters are deleted after about an hour, or at the end of the day for daily limits. When you report a product, we keep a scrambled code made from your IP address so repeated reports can be limited. The address itself isn't kept with the report.",
    ],
  },
  {
    heading: "Products made with Muse Muse",
    paragraphs: [
      "Each product has its own privacy page that says which models get which inputs and what it keeps. Most products keep nothing on a server: anything saved stays in your browser.",
    ],
  },
  {
    heading: "Your choices",
    bullets: [
      "To ask for your data to be deleted, or a product of yours to be removed, use the Report link on the product and choose privacy.",
      "Signing out removes the sign-in cookie from your browser.",
    ],
  },
];
