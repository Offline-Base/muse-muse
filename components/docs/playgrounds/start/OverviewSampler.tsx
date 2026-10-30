"use client";

import { lazy, Suspense, type ReactNode } from "react";
import { ChatPlayground, type ChatPreset } from "@/components/docs/playgrounds/common/ChatPlayground";
import { InstallCommands } from "@/components/docs/playgrounds/start/InstallCommands";
import { SectionTabs, type Section } from "@/components/docs/playgrounds/start/SectionTabs";
import { SPARK_TEXT_MODELS, WONDER_OUTPUT_CAP } from "@/components/docs/playgrounds/start/wonder";
import styles from "@/components/docs/playgrounds/start/start.module.css";

// The media playgrounds load when their tab first opens, so the overview stays light until a reader wants them.
const ImageGenPlayground = lazy(() => import("@/components/docs/media/ImageGenPlayground").then((m) => ({ default: m.ImageGenPlayground })));
const TranscribePlayground = lazy(() =>
  import("@/components/docs/media/TranscribePlayground").then((m) => ({ default: m.TranscribePlayground })),
);
const SegmentPlayground = lazy(() => import("@/components/docs/media/SegmentPlayground").then((m) => ({ default: m.SegmentPlayground })));

export type SamplerTab = "spark" | "wonder" | "image" | "voice" | "sam" | "muse-code";

export interface OverviewSamplerProps {
  slug: string;
  /** Tabs in order; the first opens. Defaults to every tab. */
  tabs?: SamplerTab[];
  /** The prompt both text tabs start with, so the two models can be compared on the same request. */
  textPrompt?: string;
  /** Output cap on the Muse Wonder tab, which keeps its cost to a cent or two. */
  wonderMaxOutputTokens?: number;
  sparkPresets?: ChatPreset[];
  imagePrompt?: string;
}

const TEXT_PROMPT =
  "In five short bullets, plan the upgrade of a Flask app from SQLAlchemy 1.4 to 2.0: the breaking changes to check and the order to make them in.";

function Lead({ children }: { children: ReactNode }) {
  return <p className={`${styles.lead} pg-advanced`}>{children}</p>;
}

function Loading() {
  return <p className="pg-wait">Loading the playground...</p>;
}

/**
 * The overview's "first call on each model": a tab per model the page introduces, each the kit's playground for it
 * with page-specific props (Muse Spark and Muse Wonder on the Responses API, Muse Image's one-shot generation, Muse
 * Voice Transcribe on a sample WAV, SAM 3.1 on a sample photo), plus Muse Code's install commands. Open-weight models
 * have no API call, so a line under the tabs points to their pages.
 */
export function OverviewSampler({
  slug,
  tabs = ["spark", "wonder", "image", "voice", "sam", "muse-code"],
  textPrompt = TEXT_PROMPT,
  wonderMaxOutputTokens = WONDER_OUTPUT_CAP,
  sparkPresets,
  imagePrompt,
}: OverviewSamplerProps) {
  const all: Record<SamplerTab, Section> = {
    spark: {
      id: "spark",
      label: "Muse Spark",
      content: (
        <div className={styles.stack}>
          <Lead>
            Muse Spark on the <code>/v1/responses</code> endpoint. The live demos default to <code>muse-spark-1.3-contributor</code>{" "}
            (Contributor mode, the lowest price); the menu also has the Standard Muse Spark models, and Muse Wonder has its own tab.
            Fractions of a cent a run.
          </Lead>
          <ChatPlayground slug={slug} prompt={textPrompt} effort="low" presets={sparkPresets} models={[...SPARK_TEXT_MODELS]} />
        </div>
      ),
    },
    wonder: {
      id: "wonder",
      label: "Muse Wonder",
      content: (
        <div className={styles.stack}>
          <Lead>
            The same request on <code>muse-wonder-1.0</code>, Meta&apos;s most capable model (Standard mode, in preview): only the model
            id changes. The page&apos;s own call uses <code>reasoning.effort: &quot;high&quot;</code>; this one starts at low with
            output capped at {wonderMaxOutputTokens} tokens, about a cent or two a run.
          </Lead>
          <ChatPlayground
            slug={slug}
            model="muse-wonder-1.0"
            models={["muse-wonder-1.0"]}
            prompt={textPrompt}
            effort="low"
            maxOutputTokens={wonderMaxOutputTokens}
            multiTurn={false}
          />
        </div>
      ),
    },
    image: {
      id: "image",
      label: "Muse Image",
      content: (
        <div className={styles.stack}>
          <Lead>
            <code>muse-image-1.0</code> generates and edits images: one-shot on <code>/v1/images/generations</code> and{" "}
            <code>/v1/images/edits</code>, or turn by turn on the Responses API. $0.01 per image.
          </Lead>
          <Suspense fallback={<Loading />}>
            <ImageGenPlayground slug={slug} modes={["generations", "responses", "edits"]} n={1} {...(imagePrompt ? { prompt: imagePrompt } : {})} />
          </Suspense>
        </div>
      ),
    },
    voice: {
      id: "voice",
      label: "Voice Transcribe",
      content: (
        <div className={styles.stack}>
          <Lead>
            <code>muse-voice-transcribe-1.0</code> turns speech into text: a file on <code>POST /v1/asr/transcribe</code>, or live
            audio on the realtime WebSocket. $0.18 per hour of audio, so the 15 s sample costs under a tenth of a cent.
          </Lead>
          <Suspense fallback={<Loading />}>
            <TranscribePlayground slug={slug} endpoints={["transcribe", "realtime"]} sampleId="speech-paragraph" />
          </Suspense>
        </div>
      ),
    },
    sam: {
      id: "sam",
      label: "SAM 3.1",
      content: (
        <div className={styles.stack}>
          <Lead>
            <code>sam-3.1</code> finds and outlines objects from a short noun phrase, on the Responses API: a box and a mask for every
            match. $2.50 per 1,000 images, so one photo is a quarter of a cent.
          </Lead>
          <Suspense fallback={<Loading />}>
            <SegmentPlayground slug={slug} media={["image", "video"]} sampleId="street" prompt="dog" />
          </Suspense>
        </div>
      ),
    },
    "muse-code": { id: "muse-code", label: "Muse Code", content: <InstallCommands /> },
  };
  const sections = tabs.map((t) => all[t]).filter(Boolean);
  return (
    <div className={styles.stack}>
      <SectionTabs label="Models" sections={sections} />
      <p className={`${styles.footnote} pg-advanced`}>
        Muse Spark Open and Muse Glimmer are open weights you run on your own hardware (or, for Muse Spark Open, through a hosted
        provider), not on Model API, so they have no call here. See{" "}
        <a className={styles.link} href="/docs/muse-spark-open">
          Muse Spark Open
        </a>{" "}
        and{" "}
        <a className={styles.link} href="/docs/muse-glimmer">
          Muse Glimmer
        </a>
        .
      </p>
    </div>
  );
}
