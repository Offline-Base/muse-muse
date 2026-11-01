"use client";

import { useRouter } from "next/navigation";
import { writeMakeDraft } from "@/components/composer/Composer";
import type { Preset } from "@/lib/gallery/presets";

/** A row of picture cards. Choosing one puts its idea in the Make page's composer, where the person can edit and send it. */
export function Presets({ presets, heading = "Presets" }: { presets: Preset[]; heading?: string }) {
  const router = useRouter();
  return (
    <section className="gx-section">
      <h2 className="gx-heading">{heading}</h2>
      <ul className="gx-presets">
        {presets.map((preset) => (
          <li key={preset.title}>
            <button
              type="button"
              className="gx-preset"
              onClick={() => {
                writeMakeDraft(preset.note);
                router.push("/");
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preset.image} alt="" loading="lazy" />
              <span>{preset.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
