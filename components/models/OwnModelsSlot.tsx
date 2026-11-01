import { BUILT_WITH_SPARK_OPEN, USAGE_POINTS } from "@/lib/caps/gpu/general";
import type { OwnModelsView } from "@/lib/caps/gpu/own-rows";
import { env } from "@/lib/env";

/**
 * "Your own models" on /models (docs/CAPABILITIES.md, section 17, wave 3's unit 11 slot): models trained for products the
 * person signed in owns, and later their paired inference devices (unit 13's `devices` table, kind "inference"). The page is
 * public, so a signed-out visitor sees nothing here. Status words only: no endpoint URLs, tokens or live calls on page
 * load. With GPU_GLIMMER_SHARED and GPU_TRAIN_ON_DATA off it renders nothing, as it always did.
 */
export function OwnModelsSlot() {
  if (!env.gpuGlimmerShared && !env.gpuTrainOnData) return null;
  return <SignedInOwnModels />;
}

/** Loaded only with a flag on, so a page with them off reads and imports none of this. */
async function SignedInOwnModels() {
  const [{ getSessionUser }, { ownModelsOf }, { safeQuery }] = await Promise.all([import("@/lib/auth"), import("@/lib/caps/gpu/own-rows"), import("@/lib/queries")]);
  const user = await getSessionUser();
  if (!user || user.openAccess) return null;
  const view = await safeQuery(() => ownModelsOf(user.id));
  return view.ok ? <OwnModelsList view={view.data} /> : null;
}

export function OwnModelsList({ view }: { view: OwnModelsView }) {
  if (!view.rows.length && !view.devices.length) return null;
  return (
    <>
      <h3 className="models-sub">Your own models</h3>
      <ul>
        {view.rows.map((r) => (
          <li key={r.jobId}>
            <strong>{r.title}</strong> for {r.product}. {r.kind} model. {r.passed ? "Passed." : "Hasn't passed."} {r.verdict}{" "}
            {r.serving ? "Open in a demo window now." : "Off outside demo windows, so its product answers with Muse Wonder."}
            {r.sparkOpen ? ` ${BUILT_WITH_SPARK_OPEN}.` : ""}
          </li>
        ))}
        {view.devices.map((d) => (
          <li key={d.name}>
            <strong>{d.name}</strong>: {d.status}.
          </li>
        ))}
      </ul>
      {view.rows.some((r) => r.sparkOpen) ? <p className="muted">{USAGE_POINTS.join(" ")}</p> : null}
    </>
  );
}
