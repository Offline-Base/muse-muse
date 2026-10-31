/**
 * Links into the phone shell (docs/NATIVE_SHELLS.md, "Opening a product"). native/ stays out of the Vercel deployment, so
 * native/releases.json can't be read at run time. A test keeps these two values in step with it.
 */

export const EAS_PROJECT_ID = "ee7dbfb2-f11f-4e19-9eb7-d5bc6212a5de";

/**
 * Whether the shell's update is on the production channel, which Expo Go needs. Flip it once `productionUpdate` in
 * native/releases.json is set.
 */
export const SHELL_UPDATE_PUBLISHED = false;

/** Opens a product in the installed Muse Muse app. */
export function appLink(slug: string): string {
  return `musemuse://open?slug=${encodeURIComponent(slug)}`;
}

/** Opens a product in the shell through Expo Go, for the owner. Spike S5 hasn't run, so the first real scan proves it. */
export function expoGoLink(slug: string): string {
  return `exp://u.expo.dev/${EAS_PROJECT_ID}/--/p/${encodeURIComponent(slug)}?channel-name=production`;
}
