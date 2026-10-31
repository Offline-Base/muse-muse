import type { ReactNode } from "react";
import type { IconName } from "@/components/icons";

/**
 * The chat kit's data (docs/UI_MUSE_APP.md): plain objects, so a surface maps what it has onto them (the docs assistant
 * its tool calls, the build room its segments) and the kit draws them the same way everywhere.
 */

/** Where a step is: still working, finished, or stopped by an error. */
export type StepState = "running" | "done" | "failed";

/**
 * What a step stands for. Subagent and workflow rows, and every row a workflow runs, show the working icon's subagent
 * variant in place of the dot.
 */
export type StepKind = "step" | "subagent" | "workflow" | "tool" | "observer";

/** A picture a step made: a screenshot or a frame, or a video by its poster. */
export interface StepMedia {
  kind: "image" | "video";
  /** The thumbnail: the image itself, or the video's poster. */
  src: string;
  alt: string;
  /** Opens the full image or the video. */
  href?: string;
}

/** One row of the steps list, with the rows nested under it. */
export interface StepItem {
  id: string;
  /** Empty for a row that is only its body, such as a message. */
  title: string;
  description?: string;
  state: StepState;
  /** What the step made: one thumbnail, or a row of them. */
  media?: StepMedia | readonly StepMedia[];
  /** What a description can't hold, such as a card or a fold, under the description and the thumbnails. */
  body?: ReactNode;
  kind?: StepKind;
  children?: StepItem[];
  /** The children start folded, and the title is the row that unfolds them. */
  folded?: boolean;
}

/** How a finished list of steps ends. A list still running has no end row. */
export type StepsEnd = "done" | "stopped" | "unfinished";

/** Something a turn used: an inspiration, a docs page, a model, a skill or a web page. */
export interface SourceItem {
  id: string;
  title: string;
  /** The secondary line: a domain, a path or a model id. */
  detail?: string;
  href?: string;
  /** A 16 px favicon or thumbnail. Without one, the kind's icon shows. */
  icon?: string;
  kind?: "inspiration" | "file" | "docs" | "model" | "skill" | "web";
}

/** A file the person sent, as a 32 px thumbnail inside their bubble. */
export interface BubbleAttachment {
  /** The picture to show. Without one, the tile shows `icon`. */
  src?: string;
  /** What it is, for screen readers: the file name, or what the picture shows. */
  alt: string;
  icon?: IconName;
  /** Opens the whole file. */
  href?: string;
}
