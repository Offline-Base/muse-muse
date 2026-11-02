import { EmptyCard } from "@/components/ui";

export default function BuildNotFound() {
  return (
    <div className="page">
      <EmptyCard icon="layers" title="No build here" action={{ href: "/builds", label: "See your musings" }}>
        <p>This link doesn&apos;t match a build. It may have a typo, or the build was removed.</p>
      </EmptyCard>
    </div>
  );
}
