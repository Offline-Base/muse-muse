"use client";

import { ImageGenPlayground, type ImageGenPlaygroundProps } from "@/components/docs/media/ImageGenPlayground";
import { DemoTabs } from "@/components/docs/playgrounds/media/DemoTabs";
import { PresetConsole, type PresetConsoleProps } from "@/components/docs/playgrounds/media/PresetConsole";
import { StatelessImageTurns, type StatelessImageTurnsProps } from "@/components/docs/playgrounds/media/StatelessImageTurns";

export interface ImageGenerationLabProps {
  slug?: string;
  /** The media kit's playground: the Responses conversation, images/generations and images/edits. */
  playground: ImageGenPlaygroundProps;
  /** store: false turns that replay the last image_generation_call. */
  stateless: StatelessImageTurnsProps;
  /** The images endpoints' other options as worked requests: streaming, signed URLs, tool_enablement. */
  options: PresetConsoleProps;
  /** Requests the page's Errors section says are refused, each rejected before any image is made. */
  errors: PresetConsoleProps;
}

/**
 * Everything image-generation covers, one tab each: generate and refine (conversation with previous_response_id,
 * reference images, one-off generations and edits, size, format, reasoning strength and tools), managing state with
 * store: false, the images endpoints' other options, and the errors the page lists.
 */
export function ImageGenerationLab({ playground, stateless, options, errors }: ImageGenerationLabProps) {
  return (
    <DemoTabs
      label="Image generation"
      tabs={[
        { id: "generate", label: "Generate and refine" },
        { id: "stateless", label: "Manage state yourself" },
        { id: "options", label: "Images endpoints" },
        { id: "errors", label: "Errors" },
      ]}
    >
      <ImageGenPlayground {...playground} />
      <StatelessImageTurns {...stateless} />
      <PresetConsole {...options} />
      <PresetConsole {...errors} label="Refused" />
    </DemoTabs>
  );
}
