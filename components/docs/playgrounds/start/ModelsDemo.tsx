"use client";

import { CompareModels } from "@/components/docs/playgrounds/start/CompareModels";
import { ModelCatalog } from "@/components/docs/playgrounds/start/ModelCatalog";
import { SectionTabs } from "@/components/docs/playgrounds/start/SectionTabs";

/**
 * The models page: the live catalog (GET /v1/models joined with the page's model cards, and GET /v1/models/{model})
 * and "Same prompt on two models", the page's choice between Muse Wonder and Muse Spark, Standard and Contributor.
 */
export function ModelsDemo({ slug, initial = "catalog" }: { slug: string; initial?: "catalog" | "compare" }) {
  return (
    <SectionTabs
      label="Models"
      initial={initial}
      sections={[
        { id: "catalog", label: "Live catalog", content: <ModelCatalog /> },
        { id: "compare", label: "Same prompt on two models", content: <CompareModels slug={slug} /> },
      ]}
    />
  );
}
