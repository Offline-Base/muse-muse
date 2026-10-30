/**
 * Sample files the docs demos offer next to every file picker, served from public/docs-samples/ (see its README.md for
 * where each one came from and its license). Demos fetch them from our own origin and send them inline, so they work
 * on localhost as well as on the live site.
 */

export type SampleKind = "image" | "video" | "audio" | "pdf" | "text";

export interface DocsSample {
  id: string;
  label: string;
  /** Path on our origin, such as /docs-samples/street.jpg. */
  src: string;
  kind: SampleKind;
  mime: string;
  bytes?: number;
  /** What it shows or says, for alt text and for demos that need to know (a transcript, the chart's numbers). */
  description?: string;
  credit?: string;
}

export const DOCS_SAMPLES: readonly DocsSample[] = [];

export function samplesOf(kind: SampleKind): DocsSample[] {
  return DOCS_SAMPLES.filter((s) => s.kind === kind);
}

export function sampleById(id: string): DocsSample | null {
  return DOCS_SAMPLES.find((s) => s.id === id) ?? null;
}
