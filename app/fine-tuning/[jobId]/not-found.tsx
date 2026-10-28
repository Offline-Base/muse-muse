import { EmptyCard } from "@/components/ui";

/** A job anyone may see has finished and been judged. Every other link, or none, lands here. */
export default function ResultNotFound() {
  return (
    <div className="page">
      <EmptyCard icon="tune" title="No results here" action={{ href: "/fine-tuning#results", label: "See all results" }}>
        <p>This link doesn&apos;t match a finished, judged fine-tuning job.</p>
      </EmptyCard>
    </div>
  );
}
