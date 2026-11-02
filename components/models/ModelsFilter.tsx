"use client";

import { useState, type ReactNode } from "react";
import type { Modality } from "@/components/models/catalog";
import { PageHeader } from "@/components/ui";

const OPTIONS: ReadonlyArray<{ value: Modality; label: string }> = [
  { value: "text", label: "Text" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
];

type Choice = "all" | Modality;

/** The /models page frame: its title and the "All modalities" dropdown. The stylesheet hides what the choice leaves out. */
export function ModelsFilter({
  title,
  subtitle,
  total,
  counts,
  children,
}: {
  title: string;
  subtitle: string;
  total: number;
  counts: Record<Modality, number>;
  children: ReactNode;
}) {
  const [choice, setChoice] = useState<Choice>("all");
  const shown = choice === "all" ? total : counts[choice];
  return (
    <div className="page models-page" data-model-filter={choice}>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <label>
            <span className="sr-only">Filter models by modality</span>
            <select className="select" value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
              <option value="all">All modalities</option>
              {OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        }
      />
      <p className="sr-only" role="status">
        {shown === 1 ? "1 model" : `${shown} models`} shown
      </p>
      {children}
    </div>
  );
}
