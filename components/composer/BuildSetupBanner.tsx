import { Icon } from "@/components/icons";

/** lib/quota.ts buildSetupRefusal's codes. Kept as strings here so client code can import this file. */
export type BuildSetupCode = "no_model_key" | "no_sandbox";

/** One plain sentence for each code. The Make page banner and the composer's error line both use it. */
export function buildSetupMessage(code: BuildSetupCode): string {
  return code === "no_model_key"
    ? "Builds are off on this machine: MODEL_API_KEY is empty. Add a Meta Model API key to .env.local and restart. Browsing, the tests and the outage drills need no key."
    : "Builds are off on this machine: Vercel Sandbox has no credentials. Run npx vercel link, then npx vercel env pull, and restart. Builds run only in Vercel Sandbox.";
}

/**
 * Shown on the Make page before anyone starts, when a build would be refused anyway (lib/quota.ts buildSetupRefusal).
 * Production has both a key and Sandbox credentials, so it never shows there.
 */
export function BuildSetupBanner({ code }: { code: BuildSetupCode | null }) {
  if (!code) return null;
  return (
    <section className="card notice" role="status" data-testid="build-setup-banner">
      <span className="notice-icon" aria-hidden>
        <Icon name="plug" />
      </span>
      <div>
        <h2>{code === "no_model_key" ? "No Meta key on this machine" : "No Vercel Sandbox on this machine"}</h2>
        <p className="muted">{buildSetupMessage(code)} See the README&apos;s Judge path.</p>
      </div>
    </section>
  );
}
