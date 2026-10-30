/**
 * The text playgrounds every page group can configure with JSON props (README.md in this folder lists them all).
 * Each is a client component that takes the page `slug` plus its own props, so a DemoSpec can point at it directly.
 */

export { ChatPlayground, type ChatPlaygroundProps, type ChatPreset } from "@/components/docs/playgrounds/common/ChatPlayground";
export { AskPagePanel, ASK_BASE } from "@/components/docs/playgrounds/common/AskPagePanel";
export { ApiConsole, type ApiConsoleProps, type FileSlot, type FileSlotSpec, type FormSpec } from "@/components/docs/playgrounds/common/ApiConsole";
export {
  StructuredOutputPlayground,
  type SchemaPreset,
  type StructuredOutputPlaygroundProps,
} from "@/components/docs/playgrounds/common/StructuredOutputPlayground";
export { ToolLoopPlayground, type ToolLoopPlaygroundProps } from "@/components/docs/playgrounds/common/ToolLoopPlayground";
