/**
 * The chat kit (docs/UI_MUSE_APP.md): the Muse app look for Muse Muse's conversation surfaces, shared by the docs
 * assistant, the composer and, later, the build room. Plain data goes in (types.ts) and the same pieces come out
 * everywhere. Styles are global chat- classes in chat.css, imported once by app/layout.tsx.
 */

export type { BubbleAttachment, SourceItem, StepItem, StepKind, StepMedia, StepState, StepsEnd } from "@/components/chat/types";
export { ChatLink, chatHref } from "@/components/chat/ChatLink";
export { WorkingIcon } from "@/components/chat/WorkingIcon";
export { UserBubble } from "@/components/chat/UserBubble";
export { WorkingStep } from "@/components/chat/WorkingStep";
export { ShowThinking } from "@/components/chat/ShowThinking";
export { SegmentedTabs, SegmentedTabPanel, type SegmentedTab } from "@/components/chat/SegmentedTabs";
export { StepsPanel, type StepsTab } from "@/components/chat/StepsPanel";
export { StepList } from "@/components/chat/StepList";
export { SourceList } from "@/components/chat/SourceList";
export { MediaCard } from "@/components/chat/MediaCard";
export { TitleChip } from "@/components/chat/TitleChip";
export { FloatButton } from "@/components/chat/FloatButton";
export { ScrollButton } from "@/components/chat/ScrollButton";
