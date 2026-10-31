/** Loads the usage page's device lab card. Admins only, and only with the lab on: otherwise it asks nothing of anyone. */
import { requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { labView } from "@/lib/native/lab-box";
import { spendView } from "@/lib/native/ledger";

export async function loadLabCard(now: Date = new Date()) {
  if (!env.nativeLab) return null;
  const user = await requireUser().catch(() => null);
  if (!user?.isAdmin) return null;
  try {
    const [spend, mac, windows] = await Promise.all([spendView(), labView("mac", now), labView("windows", now)]);
    return { spend, labs: [mac, windows], now: now.getTime() };
  } catch (err) {
    console.error("[usage] the device lab card failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
