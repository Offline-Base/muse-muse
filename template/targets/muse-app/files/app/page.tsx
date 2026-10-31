import { AppBar } from "@/components/AppBar";

// Muse Code replaces this page with the product's primary flow from brief.md (muse-app-ui skill for the look).
export default function Home() {
  return (
    <>
      <AppBar name="Your product" />
      <main className="stack">
        <header className="hero">
          <h1>Your product goes here</h1>
          <p className="tagline">Muse Code builds this page from the brief.</p>
        </header>
      </main>
    </>
  );
}
