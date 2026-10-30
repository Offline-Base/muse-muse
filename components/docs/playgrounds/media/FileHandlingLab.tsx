"use client";

import { FilesPlayground, type FilesPlaygroundProps } from "@/components/docs/media/FilesPlayground";
import { DemoTabs } from "@/components/docs/playgrounds/media/DemoTabs";
import { InlineFilePlayground, type InlineFilePlaygroundProps } from "@/components/docs/playgrounds/media/InlineFilePlayground";

export interface FileHandlingLabProps {
  slug?: string;
  inline: InlineFilePlaygroundProps;
  upload: FilesPlaygroundProps;
}

/**
 * The two paths file-handling compares, one tab each: send the file inline in the request (file_data, a Chat
 * Completions file block, file_url, input_video), or upload it once with the Files API and reuse its id (the media
 * kit's FilesPlayground: upload with expires_after, list, retrieve, download, delete, then reference the file_id).
 */
export function FileHandlingLab({ inline, upload }: FileHandlingLabProps) {
  return (
    <DemoTabs
      label="File handling"
      tabs={[
        { id: "inline", label: "Send it inline" },
        { id: "upload", label: "Upload once, reuse the id" },
      ]}
    >
      <InlineFilePlayground {...inline} />
      <FilesPlayground {...upload} />
    </DemoTabs>
  );
}
