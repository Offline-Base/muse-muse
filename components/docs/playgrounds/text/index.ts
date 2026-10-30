/**
 * The text group's demos (README.md in this folder lists their props). Each is a client component that takes the
 * page `slug` plus plain JSON props, so lib/docs/demos/text.ts can point at it directly.
 */

export { ToolCallingDemo, type ToolCallingDemoProps, type ToolScenario } from "@/components/docs/playgrounds/text/ToolCallingDemo";
export { ToolSearchPlayground, type ToolSearchPlaygroundProps, type ToolSearchPreset } from "@/components/docs/playgrounds/text/ToolSearchPlayground";
export { SearchGroundingPlayground, type SearchGroundingPlaygroundProps, type GroundingPreset } from "@/components/docs/playgrounds/text/SearchGroundingPlayground";
export { ReasoningLab, type ReasoningLabProps, type ReasoningPreset } from "@/components/docs/playgrounds/text/ReasoningLab";
export { StructuredOutputDemo, SchemaSizeCheck, type StructuredOutputDemoProps, type SizePreset } from "@/components/docs/playgrounds/text/StructuredOutputDemo";
export { PromptCachingLab, type PromptCachingLabProps, type CacheScenarioSpec } from "@/components/docs/playgrounds/text/PromptCachingLab";
export { TokenCounter, type TokenCounterProps } from "@/components/docs/playgrounds/text/TokenCounter";
export { RuleChecks, type RuleChecksProps } from "@/components/docs/playgrounds/text/RuleChecks";
export { AnswerText, type CiteRender } from "@/components/docs/playgrounds/text/AnswerText";
export type { RuleCheck } from "@/components/docs/playgrounds/text/rules";
