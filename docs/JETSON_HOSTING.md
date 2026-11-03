# Muse Muse and Muse Code on a Jetson

Steps for Hussam, written Nov 2, 2026, night, from the owner's request: host the Muse Muse site on a Jetson, and run Muse Code on a Jetson. Nothing here has run on a board yet. Hussam owns the boards and decides which one; jetson-05 is never used, and jetson-02 and 03 were set aside for the on-board Glimmer training work, so check with that work before using either. jetson-04 runs SAM 3.1 at about 6.4 of 7.5 GB, so it can't also hold the site.

## What's known
- **Muse Code supports the board's platform.** Meta's launcher (`https://api.meta.ai/muse-launcher.sh`, read Nov 2) maps `Linux:aarch64` to its `aarch64_linux` build. Install with Meta's one-line installer: `curl -fsSL https://dev.meta.ai/install.sh | sh`.
- **Muse Code can use Muse Spark Open.** `scripts/open/muse-code-relay.mjs` ran a task on Baseten from the laptop (docs/BUILD_LOG.md, "Muse Code runs on Muse Spark Open"). The same relay runs on a board.
- **Building needs the internet.** Every model Muse Code can use today (Meta's API, or Spark Open on a partner) is in the cloud. One-bit Glimmer on a board writes 5 to 6 tokens a second, too slow for Muse Code's 57,000-token steps.
- **`next start` on the local database (PGlite) has not run anywhere yet** (README, Docker section). Try it on the laptop first if there's time.

## Muse Code on a board (about 30 minutes)
1. Use a separate user with no fleet keys, tokens or SSH keys in its home: Muse Code runs commands with that user's rights.
2. As that user: `curl -fsSL https://dev.meta.ai/install.sh | sh`, then `muse --version`.
3. In an empty folder: `muse exec --api-key-stdin --max-model-steps 3 --json --yolo "Create a file named hello.txt that contains exactly the word hi, then stop."`, with a Meta Model API key piped on stdin from a file only that user can read. Never paste a key into a command line.
4. Report the version, exit code, time taken and free memory during the run. Add one line to docs/BUILD_LOG.md.

## The site on a board (about 2 hours, after the repo is public)
1. Node 22 for arm64, then `git clone https://github.com/Offline-Base/muse-muse.git`.
2. `npm ci` (slow on the board; watch free disk and memory), `cp .env.example .env.local`, then `npm run dev:local`.
3. Open `http://<board>:3000` from the laptop on the local network. A local run starts with an empty gallery (README, Quickstart).
4. To build a product from the board, add a Meta key and Vercel Sandbox credentials as the README's Judge path says. Builds still run in Vercel Sandbox, not on the board.
5. Report what loaded, free memory and any errors. Keep addresses out of docs and frames.
