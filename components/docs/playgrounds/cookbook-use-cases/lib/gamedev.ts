/**
 * The game and web-design recipes' prompts, as data a demo can edit and send: one-shot-game-dev's AGENTS.md and its
 * structured prompt (experience, tech constraints, acceptance criteria), iterative-game-dev's build, play-test and
 * refinement prompts, and browser-verified-web-design's build, self-check and refinement prompts. In OpenCode the
 * model writes files; on the API it returns them, so every prompt here ends by asking for one self-contained
 * index.html in a fenced block, which the demo runs in a sandboxed frame.
 */

import type { Probe } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";

/** The recipe's AGENTS.md, as it ships. */
export const CROSSY_AGENTS_MD = `# AGENTS.md: Crossy Road

Forward = negative Z (W/Up decreases the row; score = -row); the character faces +Z,
so a forward move faces rotation.y = PI. Camera sits behind the player, looking forward.

Collision is by mesh world position (both X and Z), never by grid row. Row-only
checks kill the player from adjacent lanes.

Water is deadly unless on a log: drift with the log, don't snap the player's X back to
the grid, drown if they slide off.

Trains flash a warning, then cross fast; spawn the train rear-first (locomotive leading
inward) or it gets culled off-screen immediately.

Load the real Kenney GLBs: list each folder for exact filenames, then load/cache/clone
(box only as a per-file fallback): player = cube-pet animals from kenney_cube-pets,
cars from kenney_car-kit, trains from kenney_train-kit (re-center off-origin models).`;

export interface PromptSection {
  id: string;
  label: string;
  text: string;
}

/** The recipe's one-shot prompt, split into the sections its "fixed shape" names. */
export const CROSSY_SECTIONS: PromptSection[] = [
  {
    id: "role",
    label: "Role and deliverable",
    text: "Build a Crossy Road game as a single self-contained index.html. See AGENTS.md for the coordinate system, collision model, log riding, train spawning, and Kenney asset pipeline, and follow it exactly.",
  },
  { id: "tech", label: "Tech", text: "Tech: Three.js r160 via importmap (no build step, no npm). Runs with `python3 -m http.server 8080`. Desktop + mobile." },
  {
    id: "player",
    label: "Player",
    text: "Player: a cube-pet from the Kenney Cube Pets pack (blocky animal). 6 selectable variants (fox/cat/panda/pig/koala/polar). Grid movement with a squash/stretch hop.",
  },
  {
    id: "assets",
    label: "Assets",
    text: "Assets: load the REAL Kenney GLB models. First list the three GLB folders (kenney_cube-pets_1.0, kenney_car-kit, kenney_train-kit, each under `assets/<pack>/Models/GLB format/`) to get exact filenames, then load/cache/clone them (see AGENTS.md). Use a colored box only as a per-file fallback, not the default.",
  },
  {
    id: "world",
    label: "World",
    text: "World: infinite forward-scrolling grid of lanes: grass (tree obstacles), road (cars), water (rideable logs, drown if you miss), rail (trains with a warning flash + horn). Difficulty scales with score. Coins on grass lanes.",
  },
  {
    id: "feel",
    label: "Feel",
    text: "Feel: isometric follow camera with smooth lerp; WebAudio SFX for hop/coin/crash/splash; particle bursts; camera shake on death; touch swipe + on-screen D-pad for mobile.",
  },
  { id: "ui", label: "UI", text: "UI: Score / Best / Coins HUD; start screen with character select; game-over with restart; high score in localStorage." },
  {
    id: "acceptance",
    label: "Acceptance criteria",
    text: [
      "Acceptance criteria:",
      "- WASD/arrows move the cube-pet on the grid with a hop.",
      "- Cars kill only on real overlap (position-based collision, per AGENTS.md).",
      "- Logs are rideable; falling in the water drowns you.",
      "- Trains warn, then cross fast; real Kenney GLB pets, cars, and trains render (boxes only if a file fails).",
      "- Runs via python3 -m http.server, single index.html, no build step.",
    ].join("\n"),
  },
  { id: "go", label: "Go", text: "Build the complete game now." },
];

/** What replaces the assets section when no Kenney files exist (this sandbox has none). */
export const NO_ASSETS_TEXT =
  "Assets: no asset files are available in this environment, so build every model procedurally from boxes and simple shapes, styled to look like blocky Kenney-style pets, cars and trains.";

/** A smaller spec in the same shape, for a faster first run: 2D canvas, no libraries. */
export const CANVAS_SECTIONS: PromptSection[] = [
  { id: "role", label: "Role and deliverable", text: "Build a top-down 2D Crossy Road style game as a single self-contained index.html." },
  { id: "tech", label: "Tech", text: "Tech: plain JavaScript and one <canvas>, no libraries, no external files, no build step." },
  { id: "player", label: "Player", text: "Player: a blocky chicken that hops one grid cell per key press with a short squash and stretch." },
  {
    id: "world",
    label: "World",
    text: "World: endless rows scrolling upward: grass with trees, roads with cars at different speeds, and rivers with logs to ride (drown if you miss). Difficulty rises with score.",
  },
  { id: "ui", label: "UI", text: "UI: score and best (in localStorage), a start screen, and game over with restart on R or Space." },
  {
    id: "acceptance",
    label: "Acceptance criteria",
    text: [
      "Acceptance criteria:",
      "- Arrow keys and WASD move the player one cell with a hop.",
      "- Collision uses the player's and the car's real positions, not just the row.",
      "- Logs carry the player sideways; falling in the water ends the game.",
      "- Runs from one index.html with no network access.",
    ].join("\n"),
  },
  { id: "go", label: "Go", text: "Build the complete game now." },
];

export const CANVAS_AGENTS_MD = `# AGENTS.md: 2D Crossy Road

Forward = up the screen (Up/W decreases the row; score = rows moved forward). The camera scrolls so the player stays in
the lower third.

Collision is by the player's and the obstacle's pixel rectangles, never by row alone.

On a log the player drifts with it; don't snap x back to the grid. Off the log over water: game over.

Keep it to one file: inline CSS and JS, no network.`;

/** The line every prompt ends with, since the API returns files instead of writing them. */
export const SINGLE_FILE_OUTPUT = "Reply with the complete index.html in one fenced ```html block: inline CSS and JS, everything in that one file.";

export function sectionsText(sections: PromptSection[], replaceAssets: boolean): string {
  return sections
    .map((s) => (s.id === "assets" && replaceAssets ? NO_ASSETS_TEXT : s.text))
    .filter((t) => t.trim())
    .join("\n\n");
}

/** AGENTS.md goes in as the instructions, the way OpenCode loads it every turn. */
export function agentsInstructions(agentsMd: string): string {
  const md = agentsMd.trim();
  return [md ? `The project's AGENTS.md (follow it exactly):\n\n${md}` : "", SINGLE_FILE_OUTPUT].filter(Boolean).join("\n\n");
}

export interface RefinePass {
  label: string;
  prompt: string;
  /** The browser check this pass ends with, when it isn't the loop's usual one (one probe list per screenshot). */
  probes?: Probe[][];
  probeLabels?: string[];
}

export interface LoopSpec {
  build: string;
  check: string;
  probes: Probe[][];
  probeLabels: string[];
  refine: RefinePass[];
  frameTitle: string;
}

export const SITE_LOOP: LoopSpec = {
  build:
    'I want to create a new website for my company named "Mesh Network Solutions". Create me a template with a title website showing the company name in ASCII art in a terminal-like font and create an interactive effect which will disperse the symbols away from the cursor in a circular range. Put some placeholder text under the logo.',
  check:
    "Now check your work. This is the page rendered in a real browser at 1280x800: the first screenshot is at rest, the second after the mouse moved across the center of the ASCII logo, and the console and a page snapshot are below. Review the screenshots: is the ASCII logo centered and readable, does the terminal theme look right, and is the placeholder text visible? Report what you actually see, then fix what's broken.",
  probes: [[{ type: "wait", ms: 400 }], [{ type: "mouse", path: "across-logo", ms: 900 }, { type: "wait", ms: 120 }]],
  probeLabels: ["At rest", "Mouse over the logo"],
  refine: [
    {
      label: "Green CRT terminal",
      prompt:
        "The design works but I want a different aesthetic. Refine it into a retro CRT green-phosphor terminal look: near-black background with a slight green tint (#060b07) and a subtle scanline overlay; phosphor-green text (body #9dffb0, accents #4cff8a) with a soft glow on the ASCII logo; a terminal/monospace font pairing (VT323 + IBM Plex Mono from Google Fonts); a terminal header bar showing `user@mns:~$ ./welcome.sh`; section headings styled as comments (`// about`, `// services`, `// contact`) and bullet lists prefixed with `> `; an outlined-green CTA button and a blinking block cursor in the footer. Keep the interactive dispersion effect.",
    },
  ],
  frameTitle: "index.html (Mesh Network Solutions)",
};

export const GAME_LOOP: LoopSpec = {
  build:
    "Build the 3D car racing game with Three.js (from a CDN via importmap, no build step). Theme, solar system: a big flaming sun in the middle (emissive glowing sphere with animated procedural fire, corona, point light) and a starfield background. Track: a closed loop that orbits the sun like a planetary ring, surface rainbow-colored (hue cycles around the loop), with barriers. Car: a gokart built from simple shapes (no model files are available here). Gokart-style arcade physics: responsive accel, momentum, grippy turning, slight drift; WASD/arrows; chase camera. HUD: speed + lap counter. Self-contained.",
  check:
    "Check the game works. This is it running in a real browser at 1280x800: the first screenshot after it loaded, the second after holding accelerate (ArrowUp) with a turn key (ArrowLeft) for a second and a half, and the browser console and a page snapshot are below. Review: is the sun visible and flaming, is the track rainbow, did the kart render, any console errors? Report what you see and fix what's broken.",
  probes: [[{ type: "wait", ms: 900 }], [{ type: "keys", keys: ["ArrowUp", "ArrowLeft"], holdMs: 1500 }]],
  probeLabels: ["Loaded", "Holding Up + Left"],
  refine: [
    {
      label: "Pass 1: sun and full rainbow",
      prompt:
        "Make the theme shine: a prominent flaming sun as the centerpiece (bigger, turbulent fire, corona and bloom, warm light), tilt the chase camera inward so the sun is in frame, and make the track a full ROYGBIV ring with the hue sweeping 0 to 360 degrees exactly once around the loop. Add a top-down overview camera on V.",
    },
    {
      label: "Pass 2: camera, speed strips, particles",
      prompt:
        "1. Camera bug: the chase cam zooms in when accelerating so you can't see ahead; make it pull back and increase look-ahead with speed. 2. Track speed strips: build the track from distinct transverse strips with gaps that stream past for a sense of speed, keeping the hue cycling around the loop. 3. Sun particles: add an additive-blended particle system of embers drifting outward from the sun.",
    },
    {
      label: "Pass 3: a real circuit and correct steering",
      prompt:
        "1. Steering and physics: the steering feels inverted and the kart slides rather than driving. Fix it so left turns left and right turns right, and the kart points and moves in the direction it's facing with responsive gokart handling. 2. Track layout: the plain circle is boring. Make it a real race circuit (sweeping curves, a couple of tight hairpins, a chicane, a longer straight) that still orbits the sun and keeps the rainbow speed strips.",
      // The recipe's verification: hold left and see it curve left, hold right for right, then the top-down overview.
      probes: [[{ type: "keys", keys: ["ArrowUp", "ArrowLeft"], holdMs: 1500 }], [{ type: "keys", keys: ["ArrowUp", "ArrowRight"], holdMs: 1500 }], [{ type: "keys", keys: ["v"], holdMs: 120 }, { type: "wait", ms: 500 }]],
      probeLabels: ["Holding Up + Left", "Holding Up + Right", "Overview camera (V)"],
    },
    {
      label: "Pass 4: smooth chase camera",
      prompt:
        "When I press a steering key the camera snaps and rotates instantly with the kart, so the view jerks sideways instead of the kart turning within a stable view. Make the chase camera follow smoothly: ease the camera position and look-target toward the kart with damping (exponential smoothing) so it gently catches up rather than teleporting; make steering gradual and speed-scaled. So the browser check can measure it, expose window.__sampleCamera = () => ({ camYaw, kartYaw, camX, camZ }) with the camera's and the kart's yaw in radians and the camera's position.",
      // Pass 4 is a feel bug a screenshot can't show, so the check samples the camera every 100 ms during a held turn
      // (the recipe uses browser_evaluate per frame); the samples land in the console the model reads.
      probes: [[{ type: "sample", fn: "__sampleCamera", keys: ["ArrowUp", "ArrowLeft"], holdMs: 1500, everyMs: 100 }]],
      probeLabels: ["Holding Up + Left, camera sampled every 100 ms"],
    },
  ],
  frameTitle: "index.html (solar racer)",
};

/** The user text of a check round: the prompt, then the console and the snapshot as the browser saw them. */
export function checkText(prompt: string, consoleLines: string[], snapshot: string): string {
  const consoleText = consoleLines.length ? consoleLines.slice(-40).join("\n") : "(no console output)";
  return [
    prompt,
    "",
    "Browser console:",
    consoleText,
    "",
    "Page snapshot:",
    snapshot.slice(0, 3500) || "(empty)",
    "",
    `First say in a few sentences what you see and what's broken. Then ${SINGLE_FILE_OUTPUT.charAt(0).toLowerCase()}${SINGLE_FILE_OUTPUT.slice(1)}`,
  ].join("\n");
}

/** The review part of a reply: the text before the fenced HTML. */
export function reviewText(reply: string): string {
  const at = reply.search(/```(?:html|htm)?\s*\n/i);
  const head = (at >= 0 ? reply.slice(0, at) : reply.split(/<!doctype html/i)[0]).trim();
  return head.slice(0, 2500);
}
