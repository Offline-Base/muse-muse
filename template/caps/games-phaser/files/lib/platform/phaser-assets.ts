// Platform file (Muse Muse platform services). Don't edit. Phaser draws in 2D, so a 3D asset from the platform's free
// set shows in a Phaser game as its preview picture (the "preview" file, 512 px). This adds one as a texture after
// checking its size and sha256 against the asset list (lib/platform/assets3d.ts), so a changed file is never shown.
import type Phaser from "phaser";
import { AssetError, assetFile, assetUrl, fetchVerified, type Asset3d } from "@/lib/platform/assets3d";

const TYPES: Record<string, string> = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

/**
 * Adds an asset's preview picture to the scene's textures under `key`, from the asset store at `base`. Throws
 * AssetError in plain words when it can't be fetched or doesn't match its listing.
 */
export async function addAssetPreview(scene: Phaser.Scene, key: string, asset: Asset3d, base: string): Promise<void> {
  const file = assetFile(asset, "preview");
  if (!file) throw new AssetError(`${asset.title} has no preview picture.`);
  const type = TYPES[file.path.split(".").pop()!.toLowerCase()];
  if (!type) throw new AssetError(`${asset.title}'s preview isn't a WebP, JPEG or PNG picture.`);
  const data = await fetchVerified(assetUrl(base, file), file);
  const url = URL.createObjectURL(new Blob([data], { type }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (scene.textures.exists(key)) scene.textures.remove(key);
    scene.textures.addImage(key, img);
    // The texture keeps reading the picture, so its address lives as long as the scene.
    scene.events.once("destroy", () => URL.revokeObjectURL(url));
  } catch {
    URL.revokeObjectURL(url);
    throw new AssetError(`${asset.title}'s preview couldn't be read as a picture.`);
  }
}
