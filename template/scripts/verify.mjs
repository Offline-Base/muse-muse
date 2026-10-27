// Definition of done for a Muse Muse product. See .agents/skills/verify/SKILL.md.
//
// TODO(kickoff, day 4): implement these steps and exit 0 only when all of them pass.
//   1. tsc --noEmit
//   2. next build
//   3. next start on port 3100, then GET / must return 200 with no console errors
//   4. playwright test tests/smoke.spec.ts --project=smoke
//   5. validate musemuse.json against musemuse.schema.json with ajv
//   6. print a one-line JSON summary on the last line of output, for the platform to parse
//
// After verify passes, the platform (not this script) runs `npm run demo`, then uses ffmpeg to turn
// test-results/**/video.webm into demo.mp4 with a title card, and builds captions from the step titles
// and timings in test-results/report.json.

console.error("verify is not implemented yet. This repo is a scaffold until kickoff.");
process.exit(1);
