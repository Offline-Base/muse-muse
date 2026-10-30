/**
 * File ids a demo uploaded, kept by the picked file they came from, so Run uploads a file once and then references
 * its id. Docs uploads last an hour (the proxy sets expires_after to 3600 s and the hourly cleanup deletes them), so
 * an id is reused for 55 minutes and then the file is uploaded again. A run the proxy answers with 404 should forget
 * the ids it sent (the cookie that owns them may be gone too), so the next run uploads again.
 */

export const UPLOAD_REUSE_MS = 55 * 60_000;

export class UploadCache<K extends object> {
  private readonly ids = new WeakMap<K, { id: string; at: number }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxAgeMs = UPLOAD_REUSE_MS,
  ) {}

  /** The id of this file's upload while it's fresh, or null when it needs uploading (again). */
  get(key: K): string | null {
    const hit = this.ids.get(key);
    if (!hit) return null;
    if (this.now() - hit.at >= this.maxAgeMs) {
      this.ids.delete(key);
      return null;
    }
    return hit.id;
  }

  set(key: K, id: string): void {
    this.ids.set(key, { id, at: this.now() });
  }

  forget(key: K): void {
    this.ids.delete(key);
  }
}
