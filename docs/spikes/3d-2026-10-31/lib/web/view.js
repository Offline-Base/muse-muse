// Loads ?glb=<url> with three.js's GLTFLoader (Draco and meshopt decoders served locally), frames it with the file's own
// camera when it has one, renders one frame and reports on window.__view.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const W = 640;
const H = 480;
const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdde6f0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(4, 6, 3);
scene.add(sun);

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath("/three/examples/jsm/libs/draco/gltf/");
loader.setDRACOLoader(draco);
loader.setMeshoptDecoder(MeshoptDecoder);
const started = performance.now();
loader.load(
  q.get("glb"),
  (gltf) => {
    const root = gltf.scene;
    scene.add(root);
    let meshes = 0;
    root.traverse((o) => {
      if (o.isMesh) meshes++;
    });
    let camera = gltf.cameras[0];
    if (camera) {
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
    } else {
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      const center = box.getCenter(new THREE.Vector3());
      camera = new THREE.PerspectiveCamera(40, W / H, size / 100, size * 10);
      camera.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.5, size * 0.7));
      camera.lookAt(center);
    }
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    window.__view = {
      ok: true,
      loadMs: Math.round(performance.now() - started),
      meshes,
      triangles: renderer.info.render.triangles,
      calls: renderer.info.render.calls,
      fileCamera: Boolean(gltf.cameras[0]),
      extensionsUsed: gltf.parser.json.extensionsUsed ?? [],
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  },
  undefined,
  (e) => {
    window.__view = { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  },
);
