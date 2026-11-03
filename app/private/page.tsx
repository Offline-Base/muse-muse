import type { Metadata } from "next";
import { PrivateBody } from "@/components/private/PrivateBody";
import "@/components/private/private.css";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "Muse Privacy",
  description: "Muse Muse builds the product. Muse Privacy is how it touches your private files: a separate reader model sees them, and Muse gets tags. In this demo the reader is Muse Glimmer 30B in the cloud, on invented files.",
};

export default function PrivatePage() {
  return <PrivateBody story={env.storyPages} />;
}
