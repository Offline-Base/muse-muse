# Muse VR patterns

## The page and the scene

```tsx
// components/RoomLoader.tsx
"use client";
import dynamic from "next/dynamic";

// A canvas and WebXR need a browser, and ssr: false only works from a client component.
const Room = dynamic(() => import("@/components/Room"), { ssr: false });

export function RoomLoader() {
  return <Room />;
}
```

```tsx
// components/Room.tsx
"use client";
import type { XRStore } from "@react-three/xr";
import { useState } from "react";
import { EnterVRButton } from "@/components/xr/EnterVRButton";
import { HowToView } from "@/components/xr/HowToView";
import { Panel, PanelButton, PanelText, PanelTitle } from "@/components/xr/Panel";
import { XRStage } from "@/components/xr/XRStage";
import { useInVR } from "@/lib/xr/emulator";
import { setXRStatus } from "@/lib/xr/status";
import { useXRTarget } from "@/lib/xr/targets";

export default function Room() {
  const [store, setStore] = useState<XRStore | null>(null);
  const [score, setScore] = useState(0);
  const inVR = useInVR();
  return (
    <>
      <EnterVRButton store={store} />
      <HowToView />
      {!inVR && score > 0 ? <section className="card" data-result>Your score: {score}</section> : null}
      <div style={{ height: 360, marginTop: 16, borderRadius: 16, overflow: "hidden" }}>
        <XRStage onStore={setStore}>
          <Scene score={score} onHit={() => { setScore(score + 1); setXRStatus(`Score ${score + 1}`); }} />
        </XRStage>
      </div>
    </>
  );
}

function Scene({ score, onHit }: { score: number; onHit: () => void }) {
  const target = useXRTarget("Target");
  return (
    <>
      <mesh ref={target} position={[0.5, 1.3, -1.5]} onClick={onHit}>
        <sphereGeometry args={[0.2, 24, 16]} />
        <meshLambertMaterial color="#0064e0" />
      </mesh>
      <Panel position={[-0.6, 1.5, -1.4]} rotation={[0, 0.4, 0]}>
        <PanelTitle>Hit the target</PanelTitle>
        <PanelText>{`Score ${score}`}</PanelText>
        <PanelButton name="Next round" onClick={onHit}>Next round</PanelButton>
      </Panel>
    </>
  );
}
```

## Grabbing

Near the controller, its squeeze grabs. Far away, its trigger or a hand's pinch does. Capture the pointer so the object follows it, and test with `xr.grab`.

```tsx
const dragging = useRef(false);
const mesh = useRef<Mesh | null>(null);
const name = useXRTarget("Crate");

<mesh
  ref={(o) => { name(o); mesh.current = o; }}
  onPointerDown={(e) => {
    (e.target as unknown as { setPointerCapture(id: number): void }).setPointerCapture(e.pointerId);
    dragging.current = true;
  }}
  onPointerMove={(e) => { if (dragging.current) mesh.current?.position.copy(e.point); }}
  onPointerUp={() => { dragging.current = false; setXRStatus("Dropped the crate"); }}
>
```

## Many of the same thing

One `instancedMesh` is one draw call, however many copies it draws.

```tsx
function Stars({ count = 200 }) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = new Matrix4();
    for (let i = 0; i < count; i++) {
      m.setPosition(Math.sin(i) * 8, 1 + (i % 10) * 0.6, -4 - (i % 7));
      ref.current?.setMatrixAt(i, m);
    }
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true;
  }, [count]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <icosahedronGeometry args={[0.05, 0]} />
      <meshBasicMaterial color="#ffffff" />
    </instancedMesh>
  );
}
```

## A texture from Muse Image

Make it on the 2D page or at the start of the session through an action route, then load it. Don't ship a remote URL: save the result under `public/` during the build, or use the data URL the route returns.

```tsx
const texture = useLoader(TextureLoader, url);
<mesh position={[0, 2, -4]}>
  <planeGeometry args={[6, 3.4]} />
  <meshBasicMaterial map={texture} toneMapped={false} />
</mesh>
```

## Sound and a spoken request

Audio starts from a press. A spoken request records on the 2D page or from one panel button with `toWav16k`, then goes to Muse Voice Transcribe through an action route. Inside a product page's frame the microphone may be blocked, so say what to do instead and give a button or a sample as well.
