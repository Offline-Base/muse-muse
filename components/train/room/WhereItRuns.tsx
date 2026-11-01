import Link from "next/link";

/**
 * Where a tuned Muse Glimmer can run, honestly (docs/TRAINING.md "Fine-tune like a build", "Gadgets"): in its live
 * demo, on a computer with enough memory from its local files, and not on a Jetson Orin Nano, whose 8 GB is too little
 * for Muse Glimmer 30B. A board can train a small open model on the same examples instead, which is a different model.
 * The board's link is for admins, who are the only ones who can open /device today.
 */
export function WhereItRuns({ jobHref, admin }: { jobHref: string | null; admin: boolean }) {
  return (
    <section className="tune-where" aria-labelledby="tune-where-title">
      <h3 id="tune-where-title">Where it runs</h3>
      <ul>
        <li>
          <strong>Here, in its live demo.</strong> Try it live answers with it from one GPU for 30 minutes at a time
          {jobHref ? (
            <>
              , on <Link href={jobHref}>the job&apos;s page</Link>
            </>
          ) : null}
          .
        </li>
        <li>
          <strong>On a computer with 24 GB of memory or more,</strong> from its local files (GGUF), which the job&apos;s page
          makes once it&apos;s published.
        </li>
        <li>
          <strong>Not on a Jetson Orin Nano.</strong> Muse Glimmer 30B needs more memory than the board&apos;s 8 GB.
        </li>
        <li>
          <strong>Train a small model on your board instead:</strong> a small open model (Qwen3.5 0.8B) on the same
          examples, on the board&apos;s GPU. It isn&apos;t Muse Glimmer.
          {admin ? (
            <>
              {" "}
              <Link href="/device">Open the board</Link>
            </>
          ) : null}
        </li>
      </ul>
    </section>
  );
}
