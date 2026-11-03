import dynamic from "next/dynamic";
import Link from "next/link";
import { connection } from "next/server";
import { Composer, type Example } from "@/components/composer/Composer";
import type { StarterTab } from "@/components/composer/Starters";
import { BuildSetupBanner } from "@/components/composer/BuildSetupBanner";
import { SetupPanel } from "@/components/composer/SetupPanel";
import { FeaturedProducts } from "@/components/gallery/FeaturedProducts";
import { Icon } from "@/components/icons";
import { contributorBuildsOn, env } from "@/lib/env";
import { makeChatAllOn } from "@/lib/make/switch";
import { targetPickerNote } from "@/lib/native/readiness";
import { buildSetupRefusal } from "@/lib/quota";
import { FEATURED_SLUGS, pickFeatured } from "@/lib/gallery/featured";
import { LIVE_FRAME_SANDBOX, liveFrameAllow } from "@/lib/product-frame";
import { currentUser, listShippedProducts, safeQuery } from "@/lib/queries";

/** MAKE_CHAT_ALL: loaded only with the switch on, so the page's code and styles are as they were with it off. */
const MakeChat = dynamic(() => import("@/components/make/MakeChat").then((m) => m.MakeChat));

/**
 * The starters under the Make page's composer, laid out like Meta AI's (docs/BRAND.md, "Starters under the composer"):
 * three tabs of ideas, kept to what really builds, that fill the composer with a note, and one of photo examples that also attach their photo.
 */
const PHOTO_EXAMPLES: Example[] = [
  {
    label: "Receipt, redacted",
    text: "Read a receipt, hide what's private, and export the rest as a CSV.",
    image: "/examples/receipt.jpg",
    note: "Read a photo of a receipt, hide any card numbers and names, and let me download the store, items and total as a CSV.",
  },
  {
    label: "Sketch to live product",
    text: "Turn a napkin sketch into a working product with its own link.",
    image: "/examples/sketch.jpg",
    note: "Build this napkin sketch into a working product, and check every screen against the sketch before it goes live.",
  },
  {
    label: "Menu that answers",
    text: "Turn a menu photo into a helper that answers allergen questions.",
    image: "/examples/bakery.jpg",
    note: "Read this menu photo and build a helper that answers questions about its items and allergens, and says when the menu doesn't say.",
  },
  {
    label: "Shelf to inventory",
    text: "Count what's in a photo and keep a running inventory.",
    image: "/examples/fridge.jpg",
    note: "Count what's in my shelf photos and keep a running inventory with what changed since the last photo.",
  },
  {
    label: "Diagnosis with sources",
    text: "Identify a plant problem, and show the sources and how sure it is.",
    image: "/examples/plant.jpg",
    note: "Identify the problem with the plant in my photo, search for sources, cite them, and say how sure it is.",
  },
];

const STARTERS: StarterTab[] = [
  {
    id: "discover",
    label: "Discover",
    kind: "ideas",
    ideas: [
      { icon: "sparkle", label: "Build an app and tune its model", note: "Build an app where I paste a made-up document and get it back with private details hidden, and tune a small model on made-up documents to do the redaction." },
      { icon: "doc", label: "Tune a model that redacts", note: "Tune a model that finds and hides names, emails, phone numbers and account numbers in made-up documents, and score it against the base model." },
      { icon: "clipboard", label: "Write a training dataset", note: "Write a dataset of made-up spreadsheet questions with worked answers, ready for tuning a small model later." },
      { icon: "chart", label: "Test if AI judges catch bugs", note: "Build a tool that plants known bugs in small web apps, asks an AI reviewer to pass or fail each one, and charts how often broken software gets through." },
      { icon: "rocket", label: "Run a research agent", note: "Build an agent that takes a question, searches the web in steps, cites every claim, and says what it couldn't confirm." },
      { icon: "clipboard", label: "Meeting notes to private to-dos", note: "Turn made-up meeting notes I paste into to-dos, with names and numbers hidden before anything is saved." },
    ],
  },
  {
    id: "tune",
    label: "Tune a model",
    kind: "ideas",
    ideas: [
      { icon: "doc", label: "Private redaction", note: "Tune a model to hide personal details in made-up emails and forms while keeping the rest word for word." },
      { icon: "chart", label: "Spreadsheet analysis", note: "Tune a model to answer questions about made-up spreadsheets, showing the rows and the math behind each answer." },
      { icon: "book", label: "Says when it doesn't know", note: "Tune a model to answer from made-up school policies and say plainly when the policy doesn't cover the question." },
      { icon: "cap", label: "A tutor that gives hints", note: "Tune a model that tutors math with one hint at a time and never gives the final answer, using made-up problems." },
      { icon: "clipboard", label: "Dataset: tricky redactions", note: "Write a dataset of made-up documents with hard cases for redaction, such as names that are also common words." },
      { icon: "user", label: "Dataset: honest answers", note: "Write a dataset of made-up questions where the right answer is I don't know, paired with questions it can answer." },
    ],
  },
  {
    id: "agents",
    label: "Agents and tools",
    kind: "ideas",
    ideas: [
      { icon: "rocket", label: "Compare AI answers blind", note: "Build a lab that sends one prompt to two AI systems, hides which is which, and lets me score them, with results that add up over time." },
      { icon: "chart", label: "Analyze a CSV with proof", note: "Build an agent that answers questions about a CSV by running the numbers, and shows the rows behind each answer." },
      { icon: "doc", label: "Read a PDF and check claims", note: "Read a long PDF, list its main claims, and search for a source that supports or disputes each one." },
      { icon: "calendar", label: "Weekly brief with sources", note: "Build an agent that writes a brief on a topic I choose, with a source for every line, and marks what changed." },
      { icon: "clipboard", label: "Red team a chatbot", note: "Build a tool that tries prompt injections on a chatbot I describe, records which worked, and suggests fixes." },
      { icon: "sparkle", label: "App with a connector", note: "Build a made-up notes app that other AI tools can use through its own connector, and show a test that proves it." },
    ],
  },
  // Things people build to protect themselves: security, the edge, privacy (owner, Nov 2). Every one runs on made-up
  // data, and none gives food-safety advice or claims to stop an attack (docs/MESSAGING.md, "Don't say").
  {
    id: "protect",
    label: "Protect",
    kind: "ideas",
    ideas: [
      { icon: "chip", label: "Don't trust one sensor", note: "Build a watcher for a simulated cold room that reads a made-up controller, an independent probe and the door, warns when the two temperatures disagree or a setting is pushed far past its range, and says what to check first." },
      { icon: "alert", label: "Spot a changed setting", note: "Build a tool that reads made-up equipment logs, flags settings changed at odd hours or pushed far past their usual range, and says which change to check first." },
      { icon: "monitor", label: "Check my connected devices", note: "Build a page that reads a made-up list of a small shop's connected devices, flags old firmware and default passwords, and ranks which to take offline first." },
      { icon: "shield", label: "Is this email a scam?", note: "Build a tool where I paste a made-up email and it lists the warning signs, rates the risk and explains why, without ever opening a link." },
      { icon: "doc", label: "Hide private details first", note: "Build an app where I paste made-up documents and it hides names, emails and account numbers in code before any text is sent to a model." },
      { icon: "clipboard", label: "Outage plan for a small shop", note: "Build a plan for a made-up small shop for when the power or internet goes out: who to call, what to check first, and a checklist I can print." },
    ],
  },
  { id: "photos", label: "From a photo", kind: "photos", examples: PHOTO_EXAMPLES },
];

export default async function Home() {
  await connection();
  const user = await currentUser();
  // A build that would be refused for a missing Meta key or Sandbox credentials says so before anyone starts one.
  const setupBlock = buildSetupRefusal()?.error ?? null;
  const toolbar = (
    <>
      <div className="toolbar" aria-label="Page actions">
        <Link className="btn" href="/how-it-works">
          <Icon name="book" />
          <span>How it works</span>
        </Link>
        <Link className="btn" href="/builds">
          <Icon name="history" />
          <span>Musings</span>
        </Link>
      </div>
      <BuildSetupBanner code={setupBlock} />
    </>
  );
  if (makeChatAllOn()) {
    const { makeTrainProps } = await import("@/lib/make/page-props");
    return (
      <MakeChat
        signedIn={Boolean(user)}
        starters={STARTERS}
        targetOptions={env.enabledTargets}
        targetNote={targetPickerNote(env.waitingNativeTargets, env.enabledTargets)}
        contributorNotice={contributorBuildsOn()}
        train={makeTrainProps(user)}
        toolbar={toolbar}
        setup={<SetupPanel facts={{ buildModel: env.buildModel, judgeModel: env.judgeModel, maxFixRounds: env.maxFixRounds, publishOff: env.publishOffReason }} />}
      />
    );
  }
  // Hand-picked live products to try on the spot. A failed read only leaves the row out.
  const shipped = await safeQuery(() => listShippedProducts(FEATURED_SLUGS.length, { published: true, slugs: FEATURED_SLUGS, gallery: true }));
  const featured = shipped.ok ? pickFeatured(shipped.data) : [];
  return (
    <div className="play">
      <div className="play-main">
        {toolbar}
        {featured.length ? <FeaturedProducts products={featured} frameAllow={liveFrameAllow(null)} frameSandbox={LIVE_FRAME_SANDBOX} /> : null}
        <div className="play-intro" id="make">
          <h1>{"What’s your muse?"}</h1>
        </div>
        <Composer mode="new" signedIn={Boolean(user)} starters={STARTERS} layout="playground" targetOptions={env.enabledTargets} targetNote={targetPickerNote(env.waitingNativeTargets, env.enabledTargets)} contributorNotice={contributorBuildsOn()} />
      </div>
      <SetupPanel
        facts={{ buildModel: env.buildModel, judgeModel: env.judgeModel, maxFixRounds: env.maxFixRounds, publishOff: env.publishOffReason }}
      />
    </div>
  );
}
