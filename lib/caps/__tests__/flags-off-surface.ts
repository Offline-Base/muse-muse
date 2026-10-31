/**
 * What a build with no caps gets that wave 3 could change (docs/CAPABILITIES.md, section 1, "byte-identical"), as text,
 * for flags-off.test.ts (not a test file). Each entry is a file in golden/.
 */
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { capBuildEnv, capDeployEnv } from "@/lib/caps/env";
import { capBuildHosts } from "@/lib/caps/hosts";
import { capsFileFor, overlaysFor } from "@/lib/caps/overlays";
import { briefCaps } from "@/lib/caps/brief-fields";
import { judgeContent } from "@/lib/judge";
import { judgeInstructions } from "@/lib/prompts/judge";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { STEPS } from "@/lib/pipeline/steps";
import { builderNetworkPolicy } from "@/lib/sandbox/policy";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A sample product's sandbox and deploy, from the code as it stands, with whatever flags are set when it is called. */
export function capsOffSurface(): Record<string, string> {
  const caps = briefCaps(BRIEF);
  const { content } = judgeContent({
    brief: BRIEF,
    references: [{ kind: "image", fileName: "feeder.jpg", url: "https://x.public.blob.vercel-storage.com/feeder.jpg", contentType: "image/jpeg", bytes: 1000 } as never],
    screenshots: [
      { url: "https://x.public.blob.vercel-storage.com/01-start.png", caption: "Start" },
      { url: "https://x.public.blob.vercel-storage.com/02-result.png", caption: "Result" },
    ],
  });
  return {
    "policy.json": json(
      builderNetworkPolicy({
        modelApiKey: "test-model-key",
        placeholderKey: "mm_sandbox_0123456789abcdef",
        platformHost: "musemuse.example",
        blobUploads: true,
        ...(capBuildHosts(caps).length ? { capHosts: capBuildHosts(caps) } : {}),
      }),
    ),
    "steps.json": json(STEPS),
    "allowed-models.json": json(allowedModelsFor(BRIEF)),
    "env-local-extra.txt": capBuildEnv(BRIEF),
    "deploy-env.json": json(capDeployEnv(BRIEF, "mm_live_sample")),
    "judge-content.json": json({ instructionsLength: judgeInstructions(BRIEF).length, content }),
    "extra-files.json": json({ overlays: overlaysFor(BRIEF), capsFile: capsFileFor(BRIEF) }),
  };
}
