export interface UploadedMedia {
  /** Public URL that SAM 3.1, Muse Spark and Voice Transcribe can read. Expires after 24 hours. */
  url: string;
  contentType: string;
  size: number;
}

/**
 * Uploads a large file (video, audio, big photos) straight from the browser to storage.
 *
 * Flow: the product's server asks the gateway for a short-lived upload ticket, the browser uploads to Vercel Blob
 * with that ticket, and the server passes the returned URL to the model. Files never pass through a function body.
 *
 * TODO(kickoff, day 3): implement with @vercel/blob/client and the gateway's upload ticket route.
 */
export async function uploadMedia(file: File): Promise<UploadedMedia> {
  void file;
  throw new Error("uploadMedia is not implemented yet. This repo is a scaffold until kickoff.");
}
