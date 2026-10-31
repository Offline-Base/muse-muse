"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { IfInSessionMode, TeleportTarget, XR, XROrigin, createXRStore, type XRStore } from "@react-three/xr";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Vector3 } from "three";
import { OrbitControls as ThreeOrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ensureXR, type MuseXR } from "@/lib/xr/emulator";
import { setXRStatus, xrStatusText } from "@/lib/xr/status";
import { setXROriginObject } from "@/lib/xr/targets";

/** Eye height in the 3D preview. A headset brings its own. */
const EYE = 1.6;

/** Tells the page the stage is ready, and keeps the numbers scripts/xr-peek.mjs prints. */
function Reporter({ handle, onConnected }: { handle: MuseXR; onConnected: () => void }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const context = gl.getContext();
    const debug = context.getExtension("WEBGL_debug_renderer_info");
    Object.assign(handle.info, {
      renderer: context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER),
      antialias: context.getContextAttributes()?.antialias ?? null,
    });
    if (!xrStatusText()) setXRStatus("Ready");
    // Only now: enterVR() rejects until <XR> has handed the store its three.js renderer, and a quick click would hit that.
    onConnected();
  }, [gl, handle, onConnected]);
  useFrame(() => {
    handle.info.drawCalls = gl.info.render.calls;
    handle.info.triangles = gl.info.render.triangles;
    handle.info.buffer = `${gl.domElement.width}x${gl.domElement.height}`;
  });
  return null;
}

/** Drag to look around in the 3D preview. It stays out of a headset's way: it isn't there during a session. */
function PreviewLook() {
  const camera = useThree((s) => s.camera);
  const dom = useThree((s) => s.gl.domElement);
  useEffect(() => {
    // Measured first: the controls turn the camera to the origin as soon as they exist.
    const ahead = camera.getWorldDirection(new Vector3()).multiplyScalar(0.01).add(camera.position);
    const controls = new ThreeOrbitControls(camera, dom);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.target.copy(ahead);
    controls.update();
    return () => controls.dispose();
  }, [camera, dom]);
  return null;
}

export interface XRStageProps {
  children: ReactNode;
  /** Called once entering VR can work. Pass the store on to EnterVRButton. */
  onStore: (store: XRStore) => void;
  /** The sky's color. */
  background?: string;
  /** A plain floor and soft light, so a scene never starts in the dark. Turn off to bring your own. */
  ground?: boolean;
  /** Lets a person teleport around the floor: aim at it and press. Needs `ground`. */
  teleport?: boolean;
}

/** The canvas and the XR store, once ensureXR() has settled which kind of headset this is. */
export function XRStage({ children, onStore, background = "#dfe9f5", ground = true, teleport = false }: XRStageProps) {
  const [ready, setReady] = useState<{ handle: MuseXR; store: XRStore } | null>(null);
  const [origin, setOrigin] = useState<[number, number, number]>([0, 0, 0]);
  useEffect(() => {
    let live = true;
    void ensureXR().then((handle) => {
      if (!live) return;
      const store = createXRStore({
        // We install IWER ourselves: its built-in emulator calls installRuntime() without forceInstall.
        emulate: false,
        offerSession: handle.mode === "native" ? "immersive-vr" : false,
        controller: { teleportPointer: teleport },
        // Close up, a hand presses with its fingertip. The near grab would win over that touch whenever both reach an object,
        // and pinching from afar still grabs. A click also has to fit in the window, and the default 300 ms is too short for
        // a finger's way in and out.
        hand: { grabPointer: false, touchPointer: { clickThresholdMs: 1500 } },
        // Controller and hand models are ours, since the firewall blocks the CDN that is the default. It must be absolute:
        // the loaders call new URL(path, baseAssetPath), which throws on a relative base.
        baseAssetPath: `${location.origin}/xr/profiles/`,
      });
      setReady({ handle, store });
    });
    return () => {
      live = false;
    };
  }, [teleport]);
  const store = ready?.store;
  const connected = useCallback(() => {
    if (store) onStore(store);
  }, [store, onStore]);
  if (!ready) return null;
  const floor = (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[30, 30]} />
      <meshLambertMaterial color="#c3ccd4" />
    </mesh>
  );
  // MSAA halves a simulated headset's frame rate and a real one needs it, so it follows the mode. R3F aims a new camera at
  // the origin unless it's given a rotation, which from eye height means straight at the floor.
  return (
    <Canvas gl={{ antialias: ready.handle.mode === "native" }} dpr={[1, 1.5]} camera={{ position: [0, EYE, 0], rotation: [0, 0, 0], fov: 70, near: 0.05, far: 100 }}>
      <XR store={ready.store}>
        <Reporter handle={ready.handle} onConnected={connected} />
        <IfInSessionMode deny="immersive-vr">
          <PreviewLook />
        </IfInSessionMode>
        <XROrigin ref={setXROriginObject} position={origin} />
        <color attach="background" args={[background]} />
        {ground ? (
          <>
            <hemisphereLight args={["#ffffff", "#8899aa", 1.6]} />
            <directionalLight position={[2, 5, 3]} intensity={1.8} />
            {teleport ? <TeleportTarget onTeleport={(p) => setOrigin([p.x, 0, p.z])}>{floor}</TeleportTarget> : floor}
          </>
        ) : null}
        {children}
      </XR>
    </Canvas>
  );
}
