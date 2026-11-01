"use client";

// A Babylon.js 9 scene in a React page: a starting point. Babylon is imported inside the effect, module by module (each
// path is a file in @babylonjs/core, so the page loads only what the scene uses), and disposed when the component goes
// away. Replace the scene with the brief's, and keep the parts that make it testable: a focusable canvas that draws
// right away, keys and taps both working, small enough for software rendering.
import { useEffect, useRef } from "react";

export interface BabylonSceneProps {
  /** Called with the score whenever it changes, for the page around the scene to show. */
  onScore?(score: number): void;
}

export function BabylonScene({ onScore }: BabylonSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scoreRef = useRef(onScore);
  scoreRef.current = onScore;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let dispose: (() => void) | null = null;
    void (async () => {
      const [{ Engine }, { Scene }, { ArcRotateCamera }, { HemisphericLight }, { MeshBuilder }, { StandardMaterial }, { Vector3 }, { Color3, Color4 }, { KeyboardEventTypes }] =
        await Promise.all([
          import("@babylonjs/core/Engines/engine"),
          import("@babylonjs/core/scene"),
          import("@babylonjs/core/Cameras/arcRotateCamera"),
          import("@babylonjs/core/Lights/hemisphericLight"),
          import("@babylonjs/core/Meshes/meshBuilder"),
          import("@babylonjs/core/Materials/standardMaterial"),
          import("@babylonjs/core/Maths/math.vector"),
          import("@babylonjs/core/Maths/math.color"),
          import("@babylonjs/core/Events/keyboardEvents"),
        ]);
      if (disposed) return;
      const engine = new Engine(canvas, true, { stencil: false }, true);
      const scene = new Scene(engine);
      scene.clearColor = new Color4(0.94, 0.95, 0.96, 1);
      // A fixed camera: keys and taps steer the box. attachControl would let a drag turn the camera instead.
      new ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 3, 12, Vector3.Zero(), scene);
      new HemisphericLight("light", new Vector3(0.3, 1, 0.2), scene);
      const ground = MeshBuilder.CreateGround("ground", { width: 8, height: 8 }, scene);
      const groundMat = new StandardMaterial("ground", scene);
      groundMat.diffuseColor = Color3.FromHexString("#ced0d4");
      ground.material = groundMat;
      const box = MeshBuilder.CreateBox("player", { size: 1 }, scene);
      box.position.y = 0.5;
      const boxMat = new StandardMaterial("player", scene);
      boxMat.diffuseColor = Color3.FromHexString("#0064e0");
      box.material = boxMat;

      const held = new Set<string>();
      scene.onKeyboardObservable.add((info) => {
        if (info.type === KeyboardEventTypes.KEYDOWN) held.add(info.event.key);
        else held.delete(info.event.key);
      });
      // Touch: hold the left or right half of the canvas to steer.
      const touch = (e: PointerEvent) => {
        held.delete("ArrowLeft");
        held.delete("ArrowRight");
        if (e.type === "pointerdown") held.add(e.offsetX < canvas.clientWidth / 2 ? "ArrowLeft" : "ArrowRight");
      };
      for (const type of ["pointerdown", "pointerup", "pointercancel", "pointerleave"]) canvas.addEventListener(type, touch as EventListener);
      let score = 0;
      scene.onBeforeRenderObservable.add(() => {
        const step = engine.getDeltaTime() * 0.004;
        const dx = (held.has("ArrowRight") ? 1 : 0) - (held.has("ArrowLeft") ? 1 : 0);
        const dz = (held.has("ArrowUp") ? 1 : 0) - (held.has("ArrowDown") ? 1 : 0);
        if (!dx && !dz) return;
        box.position.x = Math.max(-3.5, Math.min(3.5, box.position.x + dx * step));
        box.position.z = Math.max(-3.5, Math.min(3.5, box.position.z + dz * step));
        box.rotation.y += step;
        scoreRef.current?.(++score);
      });

      engine.runRenderLoop(() => scene.render());
      const onResize = () => engine.resize();
      window.addEventListener("resize", onResize);
      dispose = () => {
        window.removeEventListener("resize", onResize);
        for (const type of ["pointerdown", "pointerup", "pointercancel", "pointerleave"]) canvas.removeEventListener(type, touch as EventListener);
        engine.dispose();
      };
    })();
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="game-canvas"
      tabIndex={0}
      style={{ display: "block", width: "100%", height: "min(70vh, 520px)", touchAction: "none" }}
      aria-label="3D scene. Use the arrow keys, or hold the left or right side to move."
    />
  );
}
