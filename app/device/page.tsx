import type { Metadata } from "next";
import { connection } from "next/server";
import { DeviceAsk } from "@/components/device/DeviceAsk";
import { EmptyCard, PageHeader } from "@/components/ui";
import { pageViewer } from "../fine-tuning/viewer";

export const metadata: Metadata = { title: "Device", robots: { index: false } };

/** Muse Wonder using a physical board's camera and microphone. Admins only, as /api/device/ask is. */
export default async function DevicePage() {
  await connection();
  const viewer = await pageViewer();
  if (!viewer?.isAdmin) {
    return (
      <div className="page">
        <EmptyCard
          icon="mic"
          title="Admins only"
          action={viewer ? { href: "/", label: "Back to Muse Muse" } : { href: "/sign-in?next=%2Fdevice", label: "Sign in" }}
        >
          <p>This page uses a real camera and microphone, so only admins can open it.</p>
        </EmptyCard>
      </div>
    );
  }
  return (
    <div className="page">
      <PageHeader title="Device" subtitle="Ask Muse Wonder something, and it uses the board's camera, microphone and sensors to answer." />
      <DeviceAsk />
    </div>
  );
}
