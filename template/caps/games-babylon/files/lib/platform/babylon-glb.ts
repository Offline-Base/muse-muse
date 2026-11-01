// Platform file (Muse Muse platform services). Don't edit. Loads GLB models into a Babylon.js scene the safe way: the
// bytes are fetched and checked first (lib/platform/assets3d.ts: size, sha256, glTF 2.0, self-contained, no Draco,
// meshopt or KTX2, whose decoders Babylon would fetch from its own site), and only then handed to Babylon's glTF loader.
// The loader is imported only here, so a scene with no models never loads it.
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { Scene } from "@babylonjs/core/scene";
import { AssetError, assetFile, assetUrl, checkGlb, fetchVerified, type Asset3d, type GlbInfo } from "@/lib/platform/assets3d";

async function load(scene: Scene, data: ArrayBuffer, name: string): Promise<AssetContainer> {
  const [{ LoadAssetContainerAsync }] = await Promise.all([import("@babylonjs/core/Loading/sceneLoader"), import("@babylonjs/loaders/glTF")]);
  try {
    return await LoadAssetContainerAsync(new Uint8Array(data), scene, { pluginExtension: ".glb", name });
  } catch {
    throw new AssetError("That model couldn't be read.");
  }
}

/**
 * Loads a model from the platform's free asset set (an asset from parseAssetManifest) at `base`, after checking its
 * listing's size and sha256. Returns Babylon's container: call `container.addAllToScene()` to show it. Throws
 * AssetError in plain words.
 */
export async function loadAssetModel(scene: Scene, asset: Asset3d, base: string): Promise<{ container: AssetContainer; info: GlbInfo }> {
  const file = assetFile(asset, "glb");
  if (!file) throw new AssetError(`${asset.title} has no model file.`);
  const data = await fetchVerified(assetUrl(base, file), file);
  const info = checkGlb(data);
  return { container: await load(scene, data, file.path), info };
}

/**
 * Loads a GLB the product ships itself (in public/, the same site), checked the same way but with no listing to match.
 * For a model the build made, never one fetched from another site.
 */
export async function loadOwnModel(scene: Scene, path: string, limits: { maxBytes?: number; maxTriangles?: number } = {}): Promise<{ container: AssetContainer; info: GlbInfo }> {
  if (!/^\/[A-Za-z0-9._\-/]+\.glb$/.test(path) || path.includes("..")) throw new AssetError("Load a model from this site, by a path like /models/ship.glb.");
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin" });
  } catch {
    throw new AssetError("The model couldn't be downloaded. Check your connection and try again.");
  }
  if (!res.ok) throw new AssetError(`The model couldn't be downloaded (it answered ${res.status}).`);
  const data = await res.arrayBuffer();
  const info = checkGlb(data, limits);
  return { container: await load(scene, data, path.slice(1)), info };
}
