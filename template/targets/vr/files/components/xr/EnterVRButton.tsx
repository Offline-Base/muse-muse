"use client";

import type { XRStore } from "@react-three/xr";
import { useEffect, useState } from "react";
import { ensureXR, useInVR } from "@/lib/xr/emulator";
import { setXRStatus } from "@/lib/xr/status";

/**
 * The way into VR. Its name starts with "Enter VR", which tests/xr.ts looks for, and it stays disabled until XRStage hands
 * over its store: entering before <XR> has its renderer fails. A phone has nothing to enter, so it shows no button.
 */
export function EnterVRButton({ store, label = "Enter VR" }: { store: XRStore | null; label?: string }) {
  const [opening, setOpening] = useState(false);
  const [preview, setPreview] = useState(false);
  const inVR = useInVR();
  useEffect(() => {
    void ensureXR().then((xr) => setPreview(xr.mode === "preview"));
  }, []);
  if (preview) return null;
  return (
    <button
      type="button"
      className="primary"
      disabled={!store || opening || inVR}
      aria-busy={opening}
      onClick={async () => {
        setOpening(true);
        try {
          await store?.enterVR();
        } catch {
          setXRStatus("VR didn't open. Try again.");
        } finally {
          setOpening(false);
        }
      }}
    >
      {opening ? "Opening VR..." : label}
    </button>
  );
}
