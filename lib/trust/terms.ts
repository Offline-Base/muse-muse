/**
 * The platform's Terms and Privacy pages (TRUST_LEGAL_PAGES, docs/CAPABILITIES.md, section 7).
 *
 * DRAFT. This text is a plain-language draft written for the Muse Muse owner and their counsel to review and change
 * before it is relied on. It is not legal advice, and nobody should treat it as such. It describes what the code does
 * as of TERMS_VERSION; when the code changes what it collects or keeps, change this text and TERMS_VERSION together, and
 * signed-in builders are asked to accept again.
 */

/** Bump when the Terms or Privacy text changes in a way people must accept again. Sign-in asks again for a new one. */
export const TERMS_VERSION = "2026-11-02";

/** How the pages show the date. */
export const TERMS_UPDATED = "November 2, 2026";

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

/** How to report a product: the Report link exists only with TRUST_REPORTS on. */
const REPORT_LINK_LINE = "Anyone can report a product with the Report link on it. The Muse Muse team reviews reports.";
const NO_REPORT_LINK_LINE = "Products don't have a Report link right now. To ask for a product to be removed, use the form on the Privacy page. The Muse Muse team reads each request.";

/** The Terms as they read with TRUST_REPORTS on. The page uses termsSections, which follows the flag. */
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
      REPORT_LINK_LINE,
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

/** The platform's Terms page. Without TRUST_REPORTS there's no Report link, so the text points to the Privacy page's form. */
export function termsSections(opts: { reports: boolean }): readonly LegalSection[] {
  if (opts.reports) return TERMS_SECTIONS;
  return TERMS_SECTIONS.map((s) => (s.bullets ? { ...s, bullets: s.bullets.map((b) => (b === REPORT_LINK_LINE ? NO_REPORT_LINK_LINE : b)) } : s));
}

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
        ? ["Every build right now. Your note, the files you add, your change requests and answers, and the product's code and test runs go to this model, so don't include personal, sensitive or confidential information. A product published this way keeps running on this model and says so, so what its visitors type goes there too, unless it uses a person's connected accounts or personal tools, which can't run on this model and are off for now. Products that use a gadget's or board's camera or microphone, and three demo products, stay on Muse Wonder, not this model. Fine-tunes and the live docs demos run on it too."]
        : []),
      "Test builds the Muse Muse team runs. They use made-up data only.",
      "Changes to a product first built on Muse Spark 1.3. A change carries on with the model that built the product, so your change request and the product's code go to this model.",
      ...(sparkToWonder ? [] : ["Products first built on Muse Spark 1.3 also run on it, so what people type into those products, and the files they add, go to this model."]),
    ],
  };
}

/**
 * The platform's Privacy page, which says what TRUST_SPARK_TO_WONDER and BUILDS_ON_CONTRIBUTOR do to the model tier Meta
 * may train on, what guest mode (OPEN_ACCESS=guest) means for a note, and whether products have a Report link (TRUST_REPORTS).
 */
export function privacySections(opts: { sparkToWonder: boolean; buildsOnContributor?: boolean; guestMode?: boolean; reports?: boolean }): readonly LegalSection[] {
  return [
    ...(opts.guestMode ? [GUEST_SECTION] : []),
    ...PRIVACY_BASE.flatMap((s) => (s === CONTRIBUTOR_SLOT ? [contributorSection(opts.sparkToWonder, opts.buildsOnContributor === true)] : s === CHOICES_SLOT ? [choicesSection(opts.reports === true)] : [s])),
  ];
}

/** While the site runs in guest mode, what that means for what people type. */
const GUEST_SECTION: LegalSection = {
  heading: "Guest mode",
  paragraphs: [
    "Right now you can build without an account. Everyone shares one guest account, so a build isn't tied to your name or email, and the team can't tell which build is yours unless you say. The Builds page lists every note sent from that account, so anyone can read yours. Don't put anything private in a note.",
  ],
};

/** How to ask for a deletion: the form at the end of the Privacy page, and a product's Report link while TRUST_REPORTS is on. */
function choicesSection(reports: boolean): LegalSection {
  return {
    heading: "Your choices",
    bullets: [
      `To ask for your data to be deleted, or a product of yours to be removed, use the form below${reports ? ", or the Report link on the product with privacy as the reason" : ""}. A person on the Muse Muse team reads each request and deletes by hand. This is a small project, with no automatic delete and no set reply time.`,
      "A deletion covers what Muse Muse holds: the note, files, build records and the product. It can't recall what already went to Meta or the other services above, whose own policies apply.",
      "The team keeps your request, and how to reach you if you give it, with its reports. Your IP address is kept only as the scrambled code described above.",
      "Signing out removes the sign-in cookie from your browser.",
    ],
  };
}

/** Where the choices section goes in the Privacy page. */
const CHOICES_SLOT: LegalSection = { heading: " " };

/** Where the Contributor section goes in the Privacy page. */
const CONTRIBUTOR_SLOT: LegalSection = { heading: "" };

const PRIVACY_BASE: readonly LegalSection[] = [
  {
    heading: "What we keep when you build",
    bullets: [
      "If you sign in: your email address, and your password as a scrypt hash (never the password itself). Signing in sets a cookie that keeps you signed in for 14 days.",
      "The notes, photos, sketches, recordings and files you give Muse Muse, the brief written from them, the build's log, screenshots and demo video, and the product's code. There's no set date when these are deleted.",
      "Files are stored at unguessable links, so anyone with a link can open that file. Large photos, videos and recordings a live product sends to a model go to temporary storage and are deleted after 24 hours. The screenshots the judge reads are deleted after 30 days. A product that saves files keeps them until they're deleted.",
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
      "Fine-tunes and the fine-tuning lab's live demos run on GPU machines rented from Lambda, which receive the examples a run trains on and what people type into a live demo.",
      "Product pages and the gallery are public: a product's name, what it does, its demo and how it was built can be seen by anyone.",
    ],
  },
  CONTRIBUTOR_SLOT,
  {
    heading: "Addresses and limits",
    paragraphs: [
      "Your IP address is used to limit how often sign-in, builds and products are used, and those counters are deleted after about an hour, or at the end of the day for daily limits. When you report a product or send a request from this page, we keep a scrambled code made from your IP address so repeated reports can be limited. The address itself isn't kept with the report.",
    ],
  },
  {
    heading: "Products made with Muse Muse",
    paragraphs: [
      "Each product has its own privacy page that says which models get which inputs and what it keeps. Most products keep nothing on a server: anything saved stays in your browser.",
    ],
  },
  CHOICES_SLOT,
];
