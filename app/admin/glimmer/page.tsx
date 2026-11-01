import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { GlimmerWindowControls } from "@/components/gpu/GlimmerWindowControls";
import { requireAdmin } from "@/lib/auth";
import { listGlimmerWindows } from "@/lib/caps/gpu/store";
import { windowView } from "@/lib/caps/gpu/windows";
import { env } from "@/lib/env";
import { usd } from "@/lib/format";
import { listAdapterOptions } from "@/lib/train/store";

export const metadata: Metadata = { title: "Glimmer windows" };

/**
 * Admins open and close demo windows of the shared Muse Glimmer here (docs/CAPABILITIES.md, section 17). 404 for anyone
 * else, and for everyone while GPU_GLIMMER_SHARED is off.
 */
export default async function AdminGlimmerPage() {
  await connection();
  if (!env.gpuGlimmerShared) notFound();
  try {
    await requireAdmin();
  } catch {
    notFound();
  }
  const [windows, adapters] = await Promise.all([listGlimmerWindows(), listAdapterOptions(50, { decide: true })]);
  const open = windows.find((w) => w.status === "open") ?? null;
  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1>Glimmer windows</h1>
          <p className="subtitle">Products reach the hosted Muse Glimmer only while a window is open. Up to {usd(env.gpuGlimmerDailyUsd)} a day.</p>
        </div>
      </div>
      <GlimmerWindowControls adapters={adapters.map((a) => ({ jobId: a.jobId, title: a.title }))} openWindowId={open?.id ?? null} />
      <ul>
        {windows.map(windowView).map((w) => (
          <li key={w.id}>
            {w.startsAt.slice(0, 16).replace("T", " ")} UTC: {w.status}, {w.costUsd === null ? `up to ${usd(w.capUsd)}` : usd(w.costUsd)}
          </li>
        ))}
      </ul>
    </div>
  );
}
