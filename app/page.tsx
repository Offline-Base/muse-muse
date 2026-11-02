import dynamic from "next/dynamic";
import Link from "next/link";
import { connection } from "next/server";
import { Composer, type Example } from "@/components/composer/Composer";
import type { StarterTab } from "@/components/composer/Starters";
import { SetupPanel } from "@/components/composer/SetupPanel";
import { Icon } from "@/components/icons";
import { contributorBuildsOn, env } from "@/lib/env";
import { makeChatAllOn } from "@/lib/make/switch";
import { currentUser } from "@/lib/queries";

/** MAKE_CHAT_ALL: loaded only with the switch on, so the page's code and styles are as they were with it off. */
const MakeChat = dynamic(() => import("@/components/make/MakeChat").then((m) => m.MakeChat));

/**
 * The starters under the Make page's composer, laid out like Meta AI's (docs/BRAND.md, "Starters under the composer"):
 * three tabs of ideas that fill the composer with a note, and one of photo examples that also attach their photo.
 */
const PHOTO_EXAMPLES: Example[] = [
  {
    label: "Receipt to spreadsheet",
    text: "Pull the store, items and total out of a receipt photo as a CSV.",
    image: "/examples/receipt.jpg",
    note: "Pull the store, date, items and total out of a photo of a receipt, and let me download them as a CSV.",
  },
  {
    label: "Sketch to habit tracker",
    text: "Turn this napkin sketch into a habit tracker for your phone.",
    image: "/examples/sketch.jpg",
    note: "Make this napkin sketch into a habit tracker I can use on my phone.",
  },
  {
    label: "Bakery menu boards",
    text: "Make menu boards in the style of this photo with your own items.",
    image: "/examples/bakery.jpg",
    note: "Make menu boards for my bakery in the style of this photo, but with my own items.",
  },
  {
    label: "Fridge to dinner ideas",
    text: "Suggest dinners from what's in a photo of your fridge.",
    image: "/examples/fridge.jpg",
    note: "Look at a photo of my fridge and suggest three dinners I can make tonight with what's there, with short steps.",
  },
  {
    label: "Plant care coach",
    text: "Name a plant from its photo and get a simple care plan.",
    image: "/examples/plant.jpg",
    note: "Name the plant in my photo, say what might be wrong with it, and give me a simple watering and light plan.",
  },
];

const STARTERS: StarterTab[] = [
  {
    id: "discover",
    label: "Discover",
    kind: "ideas",
    ideas: [
      { icon: "cart", label: "Turn a recipe into a shopping list", note: "Paste a recipe and get a shopping list grouped by store aisle, scaled to the number of people I'm cooking for." },
      { icon: "dumbbell", label: "Create a 20 min daily workout", note: "Make a 20 minute daily workout planner that changes the moves each day and needs no equipment." },
      { icon: "calendar", label: "Plan a fair chore rota", note: "Make a weekly chore rota for my household that rotates jobs fairly and shows who does what today." },
      { icon: "wallet", label: "Split a dinner bill", note: "Split a restaurant bill between friends, with each person's items, shared plates, tax and tip." },
      { icon: "mic", label: "Turn voice memos into to-dos", note: "Turn a voice memo into a tidy to-do list with due dates I can check off." },
      { icon: "leaf", label: "Build a plant watering schedule", note: "Make a watering schedule for my houseplants that shows what to water each day." },
    ],
  },
  {
    id: "school",
    label: "For school",
    kind: "ideas",
    ideas: [
      { icon: "book", label: "Quiz me on my notes", note: "Paste my class notes and quiz me with short questions, then show what I got wrong and why." },
      { icon: "cap", label: "Check my homework steps", note: "Check each step of my math homework and give a hint where I went wrong, without giving the answer." },
      { icon: "doc", label: "Give feedback on my essay", note: "Give feedback on my essay's thesis, evidence and structure, with the one thing to fix first." },
      { icon: "chart", label: "Graph my lab results", note: "Turn my science lab data into a clear chart and a short summary of what it shows." },
      { icon: "calendar", label: "Plan my study week", note: "Plan my study week around my classes and test dates, in short focused sessions." },
      { icon: "sparkle", label: "Explain a hard topic simply", note: "Explain a topic I'm stuck on in plain words, with an example and a quick check question." },
    ],
  },
  {
    id: "work",
    label: "For work",
    kind: "ideas",
    ideas: [
      { icon: "doc", label: "Summarize a long PDF", note: "Summarize a long PDF into key points, decisions and open questions." },
      { icon: "chart", label: "Make a dashboard from a CSV", note: "Turn a sales CSV into a dashboard with totals, trends and the top items." },
      { icon: "clipboard", label: "Build a meeting agenda", note: "Build a meeting agenda from my notes, with times, owners and the decisions we need." },
      { icon: "user", label: "Draft replies to reviews", note: "Draft friendly replies to customer reviews that match each review's tone and points." },
      { icon: "calendar", label: "Plan a shift schedule", note: "Make a weekly shift schedule for a small team that respects everyone's availability." },
      { icon: "rocket", label: "Write a launch checklist", note: "Make a launch checklist for a small product, grouped by week, showing what's done and what's next." },
    ],
  },
  { id: "photos", label: "From a photo", kind: "photos", examples: PHOTO_EXAMPLES },
];

export default async function Home() {
  await connection();
  const user = await currentUser();
  const toolbar = (
    <div className="toolbar" aria-label="Page actions">
      <Link className="btn" href="/how-it-works">
        <Icon name="book" />
        <span>How it works</span>
      </Link>
      <Link className="btn" href="/builds">
        <Icon name="history" />
        <span>History</span>
      </Link>
    </div>
  );
  if (makeChatAllOn()) {
    const { makeTrainProps } = await import("@/lib/make/page-props");
    return (
      <MakeChat
        signedIn={Boolean(user)}
        starters={STARTERS}
        targetOptions={env.enabledTargets}
        contributorNotice={contributorBuildsOn()}
        train={makeTrainProps(user)}
        toolbar={toolbar}
        setup={<SetupPanel facts={{ buildModel: env.buildModel, maxFixRounds: env.maxFixRounds, publishOff: env.publishOffReason }} />}
      />
    );
  }
  return (
    <div className="play">
      <div className="play-main">
        {toolbar}
        <div className="play-intro">
          <h1>What should Muse make?</h1>
        </div>
        <Composer mode="new" signedIn={Boolean(user)} starters={STARTERS} layout="playground" targetOptions={env.enabledTargets} contributorNotice={contributorBuildsOn()} />
      </div>
      <SetupPanel
        facts={{ buildModel: env.buildModel, maxFixRounds: env.maxFixRounds, publishOff: env.publishOffReason }}
      />
    </div>
  );
}
