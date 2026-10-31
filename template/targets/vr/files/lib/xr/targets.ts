// Platform file: don't edit. Names the objects a person can act on: the 3D version of getByRole. Tests aim at names, and
// the simulated headset learns the same list through remote.setTargetResolver, so hand sequences can reach them too.
import { useCallback } from "react";
import { Box3, Frustum, Matrix4, Quaternion, Vector3, type Camera, type InstancedMesh, type Material, type Mesh, type Object3D, type Scene } from "three";

const objects = new Map<string, Object3D>();

/** Pass the result as the object's ref: <mesh ref={useXRTarget("Start game")} />. */
export function useXRTarget(name: string): (object: Object3D | null) => void {
  return useCallback(
    (object: Object3D | null) => {
      if (object) objects.set(name, object);
      else objects.delete(name);
    },
    [name],
  );
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface XRTarget {
  name: string;
  position: Vec3;
  size?: Vec3;
}

let origin: Object3D | null = null;

/** The XROrigin the headset stands on. XRStage sets it. Everything here is told relative to it, as the headset's script is. */
export function setXROriginObject(object: Object3D | null): void {
  origin = object;
}

const plain = (v: Vector3): Vec3 => {
  const local = origin ? origin.worldToLocal(v.clone()) : v;
  return { x: local.x, y: local.y, z: local.z };
};

function bounds(object: Object3D): Box3 {
  object.updateWorldMatrix(true, true);
  return new Box3().setFromObject(object);
}

function describe(name: string, object: Object3D): XRTarget {
  const box = bounds(object);
  // uikit draws its panels with shared instanced meshes, so a panel's own box can be empty.
  if (box.isEmpty()) return { name, position: plain(object.getWorldPosition(new Vector3())) };
  const size = box.getSize(new Vector3());
  return { name, position: plain(box.getCenter(new Vector3())), size: { x: size.x, y: size.y, z: size.z } };
}

export function listTargets(): XRTarget[] {
  return [...objects].map(([name, object]) => describe(name, object));
}

/**
 * Where a hand should press: the object's own face toward the body. It goes by the object's rotation, since the world box
 * of a turned panel is much deeper than the panel. A uikit panel has no geometry of its own, so it is pressed flat on its
 * front.
 */
function surfaceOf(object: Object3D, from: Vector3 | null): { position: Vec3; normal: Vec3 } {
  object.updateWorldMatrix(true, true);
  const center = bounds(object).isEmpty() ? object.getWorldPosition(new Vector3()) : bounds(object).getCenter(new Vector3());
  const turn = object.getWorldQuaternion(new Quaternion());
  const geometry = (object as Partial<Mesh>).geometry;
  const front = new Vector3(0, 0, 1).applyQuaternion(turn);
  if (!geometry) return { position: plain(center), normal: { x: front.x, y: front.y, z: front.z } };
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const half = (geometry.boundingBox as Box3).getSize(new Vector3()).multiply(object.getWorldScale(new Vector3())).multiplyScalar(0.5);
  const toward = (from ?? center.clone().add(front)).clone().sub(center);
  const faces = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((axis, i) => {
    const direction = axis.applyQuaternion(turn);
    const along = direction.dot(toward);
    return { normal: direction.multiplyScalar(Math.sign(along) || 1), along: Math.abs(along), depth: half.getComponent(i) };
  });
  const face = faces.reduce((a, b) => (b.along > a.along ? b : a));
  return { position: plain(center.clone().addScaledVector(face.normal, face.depth)), normal: { x: face.normal.x, y: face.normal.y, z: face.normal.z } };
}

/** True when something lights the scene `object` is in. */
function hasLight(object: Object3D): boolean {
  let top = object;
  while (top.parent) top = top.parent;
  if ((top as Scene).environment) return true;
  let found = false;
  top.traverseVisible((o) => {
    if ((o as Object3D & { isLight?: boolean; intensity?: number }).isLight && (o as Object3D & { intensity: number }).intensity > 0) found = true;
  });
  return found;
}

/** Only materials that react to light have `emissive`, and with it black and no light they draw black. */
function drawsBlackUnlit(object: Object3D): boolean {
  const material = (object as Partial<Mesh>).material as Material | Material[] | undefined;
  const all = [material ?? []].flat() as Array<Material & { emissive?: { getHex(): number } }>;
  return all.length > 0 && all.every((m) => m.emissive?.getHex() === 0);
}

/**
 * How many visible meshes, lines, points and sprites under `root` the camera can see, leaving out any that no light makes
 * visible. uikit draws panels with shared instanced meshes whose bounds don't say where the panel is, so an object also
 * counts when its own position is in view. Nothing is drawn or changed, and tests call this when they ask, so a headset
 * never pays for it.
 */
export function countInView(root: Object3D, camera: Camera): number {
  const lit = hasLight(root);
  const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const position = new Vector3();
  let count = 0;
  root.traverseVisible((object) => {
    const drawn = object as Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
    if (!(drawn.isMesh || drawn.isLine || drawn.isPoints || drawn.isSprite)) return;
    if ((object as InstancedMesh).count === 0 || (!lit && drawsBlackUnlit(object))) return;
    if (frustum.containsPoint(object.getWorldPosition(position)) || frustum.intersectsObject(object)) count++;
  });
  return count;
}

/** What IWER's remote.setTargetResolver takes. */
export const targetResolver = {
  resolve(target: string | { name: string }, context?: { from?: Vec3 }) {
    const name = typeof target === "string" ? target : target.name;
    const object = objects.get(name);
    if (!object) return null;
    const from = context?.from ? new Vector3(context.from.x, context.from.y, context.from.z) : null;
    if (from && origin) origin.localToWorld(from);
    return { name, ...surfaceOf(object, from), size: describe(name, object).size };
  },
  list: listTargets,
};
