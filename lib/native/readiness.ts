/**
 * Whether the native lane can really make a product's phone and desktop apps on this site (docs/NATIVE_READY.md). Pure: the
 * caller passes PACKAGER_SNAPSHOT_ID and the shell release, so tests can try every case. Nothing here reads a flag.
 */
import type { TargetId } from "@/lib/brief/schema";
import type { ShellRelease, ShellTemplateKind } from "@/lib/native/shells";
import type { NativeEventBody } from "@/lib/types";

/** What the packager needs: its snapshot, and the shell templates it patches. */
export interface PackagerSetup {
  snapshotId: string | null;
  release: Pick<ShellRelease, "templates">;
}

/** The shell templates each target's apps are made from. */
const TEMPLATE_KINDS: Partial<Record<TargetId, readonly ShellTemplateKind[]>> = { phone: ["android"], desktop: ["mac", "windows"] };

/** Said on the product page and in the build room when no app could be made, because nothing on this site can make one. */
export const PACKAGER_MISSING = "the app packager isn't set up on this site";

/** True when the packager could make at least one of this target's apps here. vr, glasses, agent and edge need no packager. */
export function packagerReadyFor(target: TargetId, setup: PackagerSetup): boolean {
  const kinds = TEMPLATE_KINDS[target];
  if (!kinds) return true;
  return Boolean(setup.snapshotId) && kinds.some((k) => Boolean(setup.release.templates[k]));
}

/**
 * The NATIVE_TARGETS the brief writer and the composer may offer: only those the packager can make here. A phone target
 * with no packager would put "an Android app" in a brief that no step can make, and the room would still mark it as met.
 */
export function offeredNativeTargets(switchedOn: readonly TargetId[], setup: PackagerSetup): TargetId[] {
  return switchedOn.filter((t) => packagerReadyFor(t, setup));
}

/** The NATIVE_TARGETS that are switched on but can't be made here yet. Empty when NATIVE_TARGETS is. */
export function waitingNativeTargets(switchedOn: readonly TargetId[], setup: PackagerSetup): TargetId[] {
  return switchedOn.filter((t) => !packagerReadyFor(t, setup));
}

/**
 * The target picker's line while phone or desktop is switched on but can't be made. Null when nothing waits, so with
 * NATIVE_TARGETS empty the picker is exactly as it was.
 */
export function targetPickerNote(waiting: readonly TargetId[]): string | null {
  if (!waiting.length) return null;
  const apps = waiting.includes("phone") && waiting.includes("desktop") ? "Phone and desktop apps" : waiting.includes("phone") ? "Phone apps" : "Desktop apps";
  return `Only the web app and its phone home-screen install are available. ${apps} aren't made here, because ${PACKAGER_MISSING}.`;
}

const LABELS: Record<ShellTemplateKind, string> = { android: "Android", mac: "Mac", windows: "Windows" };

/** "Android", "Mac and Windows", "Android, Mac and Windows". */
function joinLabels(kinds: readonly ShellTemplateKind[]): string {
  const words = kinds.map((k) => LABELS[k]);
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The one build room line for a build whose brief asks for apps when the packager can't run. It names the apps and says
 * what the person still gets, and makes no claim that anything was packaged or checked.
 */
export function packagingSkippedEvent(input: { buildId: string; kinds: readonly ShellTemplateKind[] }): NativeEventBody {
  const target: TargetId = input.kinds.includes("android") ? "phone" : "desktop";
  const apps = joinLabels(input.kinds);
  return {
    type: "native",
    runId: `skipped-${input.buildId}`,
    origin: "ship",
    item: "package",
    target,
    state: "skipped",
    title: `The ${apps} ${input.kinds.length > 1 ? "apps weren't" : "app wasn't"} made`,
    detail: `Not made for this build: ${PACKAGER_MISSING}. The web app is live, and a phone can add it to its home screen.`,
  };
}
