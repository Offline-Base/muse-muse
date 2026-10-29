import { EmptyCard } from "@/components/ui";
import { env } from "@/lib/env";

/**
 * An order opens only for the holder of its link and for admins. Every other link, or none, lands here, with where to
 * write for a buyer who lost theirs.
 */
export default function OrderNotFound() {
  const contact = env.driveContactEmail;
  return (
    <div className="page">
      <EmptyCard icon="download" title="No order to show" action={{ href: "/fine-tuning#results", label: "See the models" }}>
        <p>
          This browser doesn&apos;t hold the key to this order. Open the link you got when you sent the request: it has the key
          in it, and opens the order on any device.
        </p>
        <p>
          Lost the link?{" "}
          {contact ? (
            <>
              Write to <a href={`mailto:${contact}`}>{contact}</a> from the email you ordered with.
            </>
          ) : (
            "Reply to your invoice's email, and we'll answer about your order there."
          )}
        </p>
      </EmptyCard>
    </div>
  );
}
