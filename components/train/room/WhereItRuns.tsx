import Link from "next/link";
import { SERVE_MINUTES_DEFAULT } from "@/lib/train/logic";
import { deviceModelTarget, LOW_BIT_FACTS } from "@/lib/train/quant-targets";

export interface WhereItRunsProps {
  /** The training job's page, where its live demo and local files are, or null. */
  jobHref: string | null;
  /** The room shows the live demo (Try it live or Start a live demo) above. */
  demoHere: boolean;
  /** The room shows the Local files card above (admins). */
  localFilesHere: boolean;
  /** Admins can open /device; nobody else can today. */
  admin: boolean;
  /** QUANT_TARGETS is on: say what is known about one-bit Glimmer on the board and a small Llama elsewhere. */
  quantTargets?: boolean;
}

/**
 * Where a tuned Muse Glimmer can run, honestly (docs/TRAINING.md "Fine-tune like a build", "Where it runs"): in its live
 * demo, on a computer with enough memory from its local files, and not on a Jetson Orin Nano, whose 8 GB is too little
 * for Muse Glimmer 30B, unless QUANT_TARGETS is on, when it says what the one-bit file measured and that it is unproven
 * on a real board. A board can train a small model on the same examples instead, which is a different model.
 * The board's link is for admins, who are the only ones who can open /device today.
 */
export function WhereItRuns({ jobHref, demoHere, localFilesHere, admin, quantTargets = false }: WhereItRunsProps) {
  const onJobPage = (what: string) =>
    jobHref ? (
      <>
        , {what} on <Link href={jobHref}>the job&apos;s page</Link>
      </>
    ) : null;
  return (
    <section className="tune-where" aria-labelledby="tune-where-title">
      <h3 id="tune-where-title">Where it runs</h3>
      <ul>
        <li>
          <strong>Here, in its live demo.</strong> One GPU serves it for a set time, {SERVE_MINUTES_DEFAULT} minutes unless
          you pick another
          {demoHere ? ", from Live demo above" : onJobPage("from Live demo")}.
        </li>
        <li>
          <strong>On a computer with 24 GB of memory or more,</strong> from its local files (GGUF, for LM Studio, llama.cpp
          and Ollama)
          {localFilesHere ? ", once Local files above has made them" : onJobPage("made from Local files")}.
        </li>
        {quantTargets ? (
          <>
            <li>
              <strong>On a Jetson Orin Nano, maybe, from one-bit Muse Glimmer.</strong> {deviceModelTarget("jetson_orin_nano").fit} Expect
              much weaker answers: on our 2026-knowledge model, this level recalled {LOW_BIT_FACTS.recallOneBitPct}% of new-knowledge probes where the
              larger Q4_K_M recalled {LOW_BIT_FACTS.recallFourBitPct}%.
            </li>
            <li>
              <strong>On other devices, from a tune on Llama 3.2 3B.</strong> {deviceModelTarget("other").fit}
            </li>
          </>
        ) : (
          <li>
            <strong>Not on a Jetson Orin Nano.</strong> Muse Glimmer 30B needs more memory than the board&apos;s 8 GB.
          </li>
        )}
        <li>
          <strong>Train a small model on your board instead:</strong> Llama 3.2 1B, Meta&apos;s small model, on the same
          examples, on the board&apos;s GPU. It isn&apos;t Muse Glimmer, and this hasn&apos;t been measured on a board yet.
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
