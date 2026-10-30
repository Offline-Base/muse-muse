/**
 * The docs media kit (docs/DOCS_MIRROR.md, "Kit" > F3b): file pickers with our samples, the microphone recorder,
 * generated-image output, the segmentation overlay, and the media playgrounds. See README.md in this folder for every
 * export and its props. The pure helpers they use live in lib/docs/media/.
 */

export { FilePicker, type FilePickerProps } from "@/components/docs/media/FilePicker";
export { AudioRecorder, type AudioRecorderProps } from "@/components/docs/media/AudioRecorder";
export { ImageOutput, type ImageOutputProps, type OutputImage } from "@/components/docs/media/ImageOutput";
export { MaskOverlay, type MaskOverlayProps, type PromptTool } from "@/components/docs/media/MaskOverlay";
export { VisionPlayground, type VisionPlaygroundProps, type VisionPreset } from "@/components/docs/media/VisionPlayground";
export { ImageGenPlayground, type ImageGenPlaygroundProps, type ImageGenMode } from "@/components/docs/media/ImageGenPlayground";
export { VideoPlayground, type VideoPlaygroundProps, type VideoSend } from "@/components/docs/media/VideoPlayground";
export { TranscribePlayground, type TranscribePlaygroundProps, type TranscribeEndpoint } from "@/components/docs/media/TranscribePlayground";
export { SegmentPlayground, type SegmentPlaygroundProps } from "@/components/docs/media/SegmentPlayground";
export { FilesPlayground, type FilesPlaygroundProps, type FilesAction } from "@/components/docs/media/FilesPlayground";
export { useObjectUrl, loadSample } from "@/components/docs/media/hooks";
export type { PickedMedia, PrepareMode } from "@/lib/docs/media/prepare";
export { DOCS_SAMPLES, samplesOf, sampleById, type DocsSample, type SampleKind } from "@/lib/docs/media/samples";
