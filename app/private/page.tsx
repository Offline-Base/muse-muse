import type { Metadata } from "next";
import { PrivateBody } from "@/components/private/PrivateBody";
import "@/components/private/private.css";

export const metadata: Metadata = {
  title: "Muse Privacy",
  description: "Muse Muse builds the product. Muse Privacy is how it touches your private files: your device reads them, and Muse gets tags.",
};

export default function PrivatePage() {
  return <PrivateBody />;
}
