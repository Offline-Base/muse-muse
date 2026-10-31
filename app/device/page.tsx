import type { Metadata } from "next";
import { connection } from "next/server";
import { DeviceAsk } from "@/components/device/DeviceAsk";
import { DeviceDrive } from "@/components/device/DeviceDrive";
import { DeviceTrain } from "@/components/device/DeviceTrain";
import { EmptyCard, PageHeader } from "@/components/ui";
import { env } from "@/lib/env";
import { pageViewer } from "../fine-tuning/viewer";

export const metadata: Metadata = { title: "Device", robots: { index: false } };

/**
 * Muse Wonder using a physical board's camera and microphone, fine-tuning on it, and, with DRIVE_EXPORT_ENABLED, putting a
 * fine-tuned model on a USB drive plugged into it. Admins only, as /api/device/ask is. ?export=board:<run> or
 * lab:<jobId>:<build> picks the model for the drive card.
 */
export default async function DevicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const [viewer, sp] = await Promise.all([pageViewer(), searchParams]);
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
      <DeviceTrain driveExport={env.driveExportEnabled} />
      {env.driveExportEnabled ? <DeviceDrive initialSource={typeof sp.export === "string" && /^(board|lab):[A-Za-z0-9._:-]{1,120}$/.test(sp.export) ? sp.export : null} /> : null}
    </div>
  );
}
