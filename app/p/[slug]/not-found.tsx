import { EmptyCard } from "@/components/ui";

export default function ProductNotFound() {
  return (
    <div className="page">
      <EmptyCard icon="grid" title="No product here" action={{ href: "/gallery", label: "Browse the gallery" }}>
        <p>This link doesn&apos;t match a product. It may have a typo, or the product was renamed.</p>
      </EmptyCard>
    </div>
  );
}
