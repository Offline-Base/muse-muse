/**
 * Creates the warm builder snapshot every product sandbox starts from. Run it again whenever template/ changes.
 *
 * TODO(kickoff, day 6, spike 5): implement with @vercel/sandbox.
 *   1. Sandbox.create with the Node 24 managed image, networkPolicy SNAPSHOT_POLICY (allow-all), ports [3000].
 *   2. Install Muse Code: curl -fsSL https://dev.meta.ai/install.sh | sh
 *   3. Copy template/ into /workspace, then npm ci and npx playwright install --with-deps chromium ffmpeg.
 *      Playwright's video recording needs its own ffmpeg build. Install system ffmpeg too, for the MP4s.
 *   4. Snapshot, then print the snapshot id to save as BUILDER_SNAPSHOT_ID.
 */
export {};
