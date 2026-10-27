import Link from "next/link";
import { connection } from "next/server";
import { Composer, type Example } from "@/components/composer/Composer";
import { Icon, type IconName } from "@/components/icons";
import { ProductCard } from "@/components/product/ProductCard";
import { currentUser, listShippedProducts, safeQuery } from "@/lib/queries";

const EXAMPLES: Example[] = [
  {
    label: "Receipt to spreadsheet",
    note: "Pull the store, date, items and total out of a photo of a receipt, and let me download them as a CSV.",
  },
  { label: "Bird counter", note: "I'll upload a short video of my bird feeder. Count the birds and outline each one." },
  {
    label: "Recipe from a voice memo",
    note: "Turn a voice memo of me explaining a recipe into a clean, printable recipe card.",
  },
  { label: "Sketch to habit tracker", note: "Make this napkin sketch into a habit tracker I can use on my phone." },
  {
    label: "Bakery menu boards",
    note: "Make menu boards for my bakery in the style of this photo, but with my own items.",
  },
];

const STEPS: Array<{ icon: IconName; title: string; text: string }> = [
  {
    icon: "sparkle",
    title: "Muse",
    text: "Drop in photos, screenshots, sketches, a short video, a voice memo or a PDF. Add a note if you want.",
  },
  {
    icon: "brief",
    title: "Brief",
    text: "Muse Spark 1.3 reads it and writes a brief: the product, who it's for, the models it needs and why, honest limits and cost.",
  },
  {
    icon: "terminal",
    title: "Build",
    text: "Muse Code builds a Next.js app from a starter template inside a sealed sandbox. You watch the log and a live preview.",
  },
  {
    icon: "clipboard",
    title: "Check",
    text: "Typecheck, build, a smoke test and a screenshot judge. Failures go back to Muse Code, up to three rounds.",
  },
  {
    icon: "rocket",
    title: "Ship",
    text: "It deploys to its own link with a recorded demo, and its actions become a connector for the Muse app.",
  },
];

export default async function Home() {
  await connection();
  const [user, recent] = await Promise.all([currentUser(), safeQuery(() => listShippedProducts(6))]);
  const products = recent.ok ? recent.data : [];

  return (
    <div className="page page-home">
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">Give it a muse. Muse makes it.</h1>
        <p className="hero-sub">
          Show an example or some inspo. Muse Code builds a working product from it on Meta&apos;s models, tests it, and
          gives you a link.
        </p>
        <Composer mode="new" signedIn={Boolean(user)} examples={EXAMPLES} />
      </section>

      {products.length ? (
        <section className="section" aria-labelledby="recent-title">
          <div className="section-head">
            <h2 id="recent-title">Recently shipped</h2>
            <Link href="/gallery" className="btn">
              <span>See all</span>
              <Icon name="chevronRight" size={16} />
            </Link>
          </div>
          <div className="grid-cards">
            {products.map((p) => (
              <ProductCard key={p.slug} p={p} compact />
            ))}
          </div>
        </section>
      ) : null}

      <section className="section" id="how-it-works" aria-labelledby="how-title">
        <div className="section-head">
          <h2 id="how-title">How it works</h2>
        </div>
        <ol className="how">
          {STEPS.map((s, i) => (
            <li key={s.title} className="how-step">
              <span className="how-icon" aria-hidden>
                <Icon name={s.icon} />
              </span>
              <h3>
                <span className="how-num">{i + 1}.</span> {s.title}
              </h3>
              <p className="muted">{s.text}</p>
            </li>
          ))}
        </ol>
        <p className="muted small">
          Products call Meta&apos;s models only through Muse Muse&apos;s metered gateway with their own scoped token.
          Nobody pastes an API key anywhere. See <Link href="/rebuilds">Rebuilds</Link> for Meta&apos;s Llama-era demos
          rebuilt on current models, and <Link href="/usage">Usage</Link> for every Meta token driven.
        </p>
      </section>
    </div>
  );
}
