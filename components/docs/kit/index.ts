/**
 * The docs demo kit (docs/DOCS_MIRROR.md, "Kit contract"): the pieces every playground is built from, so they all
 * look and behave alike. See README.md in this folder for each export's props. The playgrounds themselves live in
 * components/docs/playgrounds/common/.
 */

export { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
export { useDocsRun, isAborted, ABORTED_ERROR, type RunOptions, type RunState } from "@/components/docs/kit/useDocsRun";
export { ModelSelect } from "@/components/docs/kit/ModelSelect";
export { RunButton } from "@/components/docs/kit/RunButton";
export { ResponseView, BlobOutput, statusText, latencyLabel } from "@/components/docs/kit/ResponseView";
export { StreamView, ReplyView, EventLog, Citations, Searches, ToolCalls, Images, prettyArguments } from "@/components/docs/kit/StreamView";
export { UsageLine } from "@/components/docs/kit/UsageLine";
export { ErrorBox } from "@/components/docs/kit/ErrorBox";
export { ContributorNotice, contributorNoticeText, standardHintText } from "@/components/docs/kit/ContributorNotice";
export { CodeView } from "@/components/docs/kit/CodeView";
export { JsonEditor } from "@/components/docs/kit/JsonEditor";
export { JsonTree } from "@/components/docs/kit/JsonTree";
export {
  Field,
  TextInput,
  TextArea,
  Toggle,
  Segmented,
  PresetPills,
  EffortSelect,
  runOnModEnter,
  useModEnterHint,
  type SegmentOption,
} from "@/components/docs/kit/Field";
export { Tabs, TabPanel, type TabItem } from "@/components/docs/kit/Tabs";
export { FileSlotInput, type PickedFile } from "@/components/docs/kit/FileSlotInput";
export { DocsPageProvider, useDocsPage, type DocsPageInfo, type RecordedRequest } from "@/components/docs/kit/DocsPageContext";
export { MarkdownText } from "@/components/markdown/MarkdownText";
