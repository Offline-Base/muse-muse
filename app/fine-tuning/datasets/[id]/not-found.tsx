import { EmptyCard } from "@/components/ui";

/** A dataset anyone may see is ready. Every other link, or none, lands here. */
export default function DatasetNotFound() {
  return (
    <div className="page">
      <EmptyCard icon="file" title="No dataset here" action={{ href: "/fine-tuning#datasets", label: "See all datasets" }}>
        <p>This link doesn&apos;t match a ready training dataset.</p>
      </EmptyCard>
    </div>
  );
}
