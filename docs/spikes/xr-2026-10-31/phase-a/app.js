// Phase A: a bare three.js scene under IWER, no framework. URL options: scene=light|budget, aa=1 (MSAA), force=0 (call
// installRuntime the plain way, to confirm it skips), blank=1 (draw nothing, to prove the blank check catches it).
import * as THREE from "three";

const params = new URLSearchParams(location.search);
const statusEl = document.querySelector("[data-xr-status]");
const button = document.getElementById("enter");
const info = { nativeXR: "xr" in navigator, nativeSupported: null, emulatedSupported: null, webglError: null, renderer: null, vendor: null, webgl2: null, drawCalls: null, triangles: null };

info.nativeSupported = navigator.xr ? await navigator.xr.isSessionSupported("immersive-vr").catch((e) => `error: ${e.message}`) : false;
const { XRDevice, metaQuest3 } = await import("iwer");
const device = new XRDevice(metaQuest3, { stereoEnabled: false });
if (params.get("force") === "0") device.installRuntime();
else device.installRuntime({ forceInstall: true });
device.position.set(0, 1.6, 0);
info.emulatedSupported = await navigator.xr.isSessionSupported("immersive-vr").catch((e) => `error: ${e.message}`);

const targets = new Map();
let session = null;
let frames = 0;
const handle = {
  mode: "emulated",
  info,
  inSession: () => session !== null,
  frames: () => frames,
  waitFrames: (n, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const goal = frames + n;
      const started = performance.now();
      const check = () => {
        if (frames >= goal) resolve(frames);
        else if (performance.now() - started > timeoutMs) reject(new Error(`only ${n - (goal - frames)} of ${n} frames in ${timeoutMs} ms`));
        else setTimeout(check, 20);
      };
      check();
    }),
  remote: (method, p) => device.remote.dispatch(method, p),
  targets: () =>
    [...targets].map(([name, object]) => {
      const box = new THREE.Box3().setFromObject(object);
      const c = box.getCenter(new THREE.Vector3());
      return { name, position: { x: c.x, y: c.y, z: c.z } };
    }),
};
window.__musemuseXR = handle;

const canvas = document.createElement("canvas");
document.body.appendChild(canvas);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: params.get("aa") === "1" });
} catch (e) {
  info.webglError = String(e.message ?? e);
}

if (renderer) {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  info.renderer = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  info.vendor = gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR);
  info.webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.xr.enabled = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 100);
  camera.position.set(0, 1.6, 0);
  if (params.get("blank") === "1") {
    scene.background = new THREE.Color(0x101014);
  } else {
    scene.background = new THREE.Color(0xdfe9f5);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(2, 5, 3);
    scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0xb8c4b0, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    scene.add(new THREE.GridHelper(30, 30, 0x556677, 0x8899aa));
  }
  const box = (name, color, x, y, z, s = 0.4) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshStandardMaterial({ color }));
    mesh.position.set(x, y, z);
    mesh.name = name;
    scene.add(mesh);
    return mesh;
  };
  const start = box("Start", 0x0064e0, 0, 1.4, -1.5);
  if (params.get("blank") === "1") start.visible = false;
  targets.set("Start", start);
  if (params.get("blank") !== "1") {
    box("Red", 0xe0304a, -1.1, 1, -2);
    box("Yellow", 0xf2c230, 1.2, 1.2, -2.5);
    box("Pillar", 0x7a4ee0, 2, 1, -1, 0.8);
    box("Back", 0x20a070, 0, 1.2, 2.5, 0.8);
  }
  if (params.get("scene") === "budget") {
    // The muse-vr skill's budget: 100 draw calls and about 100k triangles, lit, in front of the viewer.
    const geometry = new THREE.IcosahedronGeometry(0.17, 6);
    for (let i = 0; i < 90; i++) {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(i / 90, 0.7, 0.55), roughness: 0.4 }));
      mesh.position.set(-2.25 + (i % 10) * 0.5, 0.4 + (Math.floor(i / 10) % 9) * 0.42, -3.2);
      scene.add(mesh);
    }
  }

  // Both controllers: a visible ray, and select picks what the ray hits.
  const ray = new THREE.Raycaster();
  const spin = new THREE.Matrix4();
  for (const i of [0, 1]) {
    const controller = renderer.xr.getController(i);
    controller.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -3)]), new THREE.LineBasicMaterial({ color: 0xffffff })));
    scene.add(controller);
    controller.addEventListener("select", () => {
      spin.identity().extractRotation(controller.matrixWorld);
      ray.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      ray.ray.direction.set(0, 0, -1).applyMatrix4(spin);
      const hit = ray.intersectObjects(scene.children, false).find((h) => targets.has(h.object.name));
      if (hit) {
        hit.object.material.color.set(0x22c55e);
        statusEl.textContent = `Selected ${hit.object.name}`;
      } else {
        statusEl.textContent = "Selected nothing";
      }
    });
  }

  button.addEventListener("click", async () => {
    const s = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
    s.addEventListener("end", () => {
      session = null;
    });
    await renderer.xr.setSession(s);
    session = s;
  });

  let lastInfo = 0;
  renderer.setAnimationLoop((time, frame) => {
    if (frame) frames++;
    renderer.render(scene, camera);
    if (time - lastInfo > 500) {
      lastInfo = time;
      info.drawCalls = renderer.info.render.calls;
      info.triangles = renderer.info.render.triangles;
    }
  });
  button.disabled = false;
}
document.documentElement.dataset.ready = "1";
