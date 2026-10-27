import Link from "next/link";
import { connection } from "next/server";
import { Composer, type Example } from "@/components/composer/Composer";
import { SetupPanel } from "@/components/composer/SetupPanel";
import { Icon } from "@/components/icons";
import { env } from "@/lib/env";
import { currentUser } from "@/lib/queries";

const EXAMPLES: Example[] = [
  {
    tag: "Photo",
    label: "Receipt to spreadsheet",
    text: "Pull the store, items and total out of a receipt photo as a CSV.",
    image: "/examples/receipt.jpg",
    note: "Pull the store, date, items and total out of a photo of a receipt, and let me download them as a CSV.",
  },
  {
    tag: "Sketch",
    label: "Sketch to habit tracker",
    text: "Turn this napkin sketch into a habit tracker for your phone.",
    image: "/examples/sketch.jpg",
    note: "Make this napkin sketch into a habit tracker I can use on my phone.",
  },
  {
    tag: "Restyle",
    label: "Bakery menu boards",
    text: "Make menu boards in the style of this photo with your own items.",
    image: "/examples/bakery.jpg",
    note: "Make menu boards for my bakery in the style of this photo, but with my own items.",
  },
];

export default async function Home() {
  await connection();
  const user = await currentUser();
  return (
    <div className="play">
      <div className="play-main">
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
        <div className="play-intro">
          <h1>Start from an example</h1>
          <p>Give it a muse and Muse makes it. Try an example, or describe your own idea below.</p>
        </div>
        <Composer mode="new" signedIn={Boolean(user)} examples={EXAMPLES} layout="playground" />
      </div>
      <SetupPanel
        facts={{ buildModel: env.buildModel, maxFixRounds: env.maxFixRounds, publishOff: env.publishOffReason }}
      />
    </div>
  );
}
