"use client";

import { useEffect, useState } from "react";
import { ensureXR, type XRMode } from "@/lib/xr/emulator";

const TEXT: Record<XRMode, string> = {
  native: "Press Enter VR, then use your controllers or your hands.",
  emulated: "No headset here, so this runs in a simulated one. Press Enter VR, then use the on-screen controls, or try it in Quest Browser on a Meta Quest.",
  preview: "This is a 3D preview. Open this page in Quest Browser on a Meta Quest to step inside.",
};

/** One line under the Enter VR button that says what to expect where the page is open now. */
export function HowToView() {
  const [mode, setMode] = useState<XRMode | null>(null);
  useEffect(() => {
    void ensureXR().then((xr) => setMode(xr.mode));
  }, []);
  return mode ? <p className="hint">{TEXT[mode]}</p> : null;
}
