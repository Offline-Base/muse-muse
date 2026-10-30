/**
 * Sample files the docs demos offer next to every file picker, served from public/docs-samples/ (see its README.md for
 * where each one came from and its license). Demos fetch them from our own origin and send them inline, so they work
 * on localhost as well as on the live site. scripts/docs/make-samples.ts makes them; lib/docs/media/__tests__ checks
 * that every entry's file exists, matches its type and size, and stays under 1.5 MB.
 */

export type SampleKind = "image" | "video" | "audio" | "pdf" | "text";

export interface DocsSample {
  id: string;
  label: string;
  /** Path on our origin, such as /docs-samples/street.jpg. */
  src: string;
  kind: SampleKind;
  mime: string;
  bytes?: number;
  /** What it shows or says, for alt text and for demos that need to know (a transcript, the chart's numbers). */
  description?: string;
  credit?: string;
  /** Pixel size, for images and video. */
  width?: number;
  height?: number;
  /** Length, for audio and video. */
  durationMs?: number;
  /** Video only: frame rate and frame count, so SAM's frame numbers line up with playback. */
  fps?: number;
  frames?: number;
  /** Prompts or questions that suit this sample, for demo presets and chips. */
  prompts?: string[];
  /** A 96 px JPEG for picker chips (images and the clip's poster), so a page doesn't load every full file. */
  thumb?: string;
}

const MUSE_IMAGE = "Generated with Muse Image (muse-image-1.0) for Muse Muse, Oct 30, 2026.";
const RENDERED = "Rendered with headless Chrome from HTML written for Muse Muse. Every name in it is fictional.";

export const DOCS_SAMPLES: readonly DocsSample[] = [
  {
    id: "street",
    label: "Street with dogs and bikes",
    src: "/docs-samples/street.jpg",
    thumb: "/docs-samples/thumbs/street.jpg",
    kind: "image",
    mime: "image/jpeg",
    bytes: 366147,
    width: 1280,
    height: 853,
    description:
      "A sunny city sidewalk. In front, a woman in a denim jacket walks two dogs on leashes, a golden retriever and a " +
      "black labrador, past a bakery window. About four bicycles stand at a rack beside cafe tables on the right, two " +
      "with red frames and one blue with a black pannier. Five or more people walk farther down the sidewalk.",
    credit: MUSE_IMAGE,
    prompts: ["dog", "person", "bicycle", "golden retriever", "cafe table"],
  },
  {
    id: "fridge",
    label: "Open fridge",
    src: "/docs-samples/fridge.jpg",
    thumb: "/docs-samples/thumbs/fridge.jpg",
    kind: "image",
    mime: "image/jpeg",
    bytes: 220994,
    width: 853,
    height: 1280,
    description:
      "An open refrigerator, seen from the front. Top shelf: a bowl of strawberries and yogurt cups. Middle shelf: a " +
      "carton of brown eggs and a glass bottle of milk. Lower shelf: two heads of romaine lettuce, tomatoes and a jar " +
      "of pickles. Bottom drawer: three clear containers with tape labels reading PASTA, SOUP and RICE. In the door: " +
      "lemons and a bottle of orange juice.",
    credit: MUSE_IMAGE,
    prompts: [
      "List every food in this fridge and which shelf it's on.",
      "Point to the milk, the eggs and the container labeled SOUP. Answer as JSON with x and y on a 0-1000 grid.",
      "What could I cook tonight with what's here?",
    ],
  },
  {
    id: "cat-sofa",
    label: "Cat on a sofa",
    src: "/docs-samples/cat-sofa.jpg",
    thumb: "/docs-samples/thumbs/cat-sofa.jpg",
    kind: "image",
    mime: "image/jpeg",
    bytes: 218783,
    width: 1280,
    height: 853,
    description: "A ginger tabby cat asleep, curled up on a grey fabric sofa against two grey cushions, with a softly blurred living room behind.",
    credit: MUSE_IMAGE,
    prompts: ["cat", "cushion", "Describe this photo in one sentence."],
  },
  {
    id: "sneaker",
    label: "Sneaker on white",
    src: "/docs-samples/sneaker.jpg",
    thumb: "/docs-samples/thumbs/sneaker.jpg",
    kind: "image",
    mime: "image/jpeg",
    bytes: 219221,
    width: 1280,
    height: 1280,
    description: "A single light grey knit running sneaker with no logo, in three-quarter view on a plain white background.",
    credit: MUSE_IMAGE,
    prompts: [
      "Make the sneaker bright orange with white laces, keep the white background.",
      "Place this sneaker on a wet city street at night, with neon reflections.",
    ],
  },
  {
    id: "living-room",
    label: "Living room",
    src: "/docs-samples/living-room.jpg",
    thumb: "/docs-samples/thumbs/living-room.jpg",
    kind: "image",
    mime: "image/jpeg",
    bytes: 281306,
    width: 1280,
    height: 853,
    description:
      "A bright living room with no people: a cream sofa with cushions and a throw, a round wooden coffee table with a " +
      "potted plant and two books, a jute rug, a tripod floor lamp, a framed print, a snake plant in a basket and a tall " +
      "window onto trees.",
    credit: MUSE_IMAGE,
    prompts: [
      "Make it an evening scene with the floor lamp on and warm light.",
      "Replace the sofa with a dark green velvet one, keep everything else.",
    ],
  },
  {
    id: "bar-chart",
    label: "Bar chart",
    src: "/docs-samples/bar-chart.png",
    thumb: "/docs-samples/thumbs/bar-chart.jpg",
    kind: "image",
    mime: "image/png",
    bytes: 48815,
    width: 1200,
    height: 800,
    description:
      "A bar chart titled \"Cups sold by drink, week of Oct 20, 2026\" for Riverside Coffee Co. Exact values: Latte 412, " +
      "Cold brew 341, Cappuccino 287, Americano 198, Mocha 156, Tea 122 (total 1,516). The y axis runs from 0 to 500.",
    credit: RENDERED,
    prompts: [
      "Read every bar's value and return them as JSON.",
      "Which drink sold the most, and by how much did it beat the second?",
    ],
  },
  {
    id: "error-screenshot",
    label: "Error screenshot",
    src: "/docs-samples/error-screenshot.png",
    thumb: "/docs-samples/thumbs/error-screenshot.jpg",
    kind: "image",
    mime: "image/png",
    bytes: 97755,
    width: 1280,
    height: 800,
    description:
      "A browser at localhost:3000/checkout showing an Unhandled Runtime Error overlay: \"TypeError: Cannot read " +
      "properties of undefined (reading 'map')\" in components/CartItems.tsx at line 14, column 27 (`cart.items.map`), " +
      "called from CheckoutPage in app/checkout/page.tsx at line 22.",
    credit: RENDERED,
    prompts: ["What's wrong here, and what's the smallest fix?"],
  },
  {
    id: "receipt",
    label: "Grocery receipt",
    src: "/docs-samples/receipt.png",
    thumb: "/docs-samples/thumbs/receipt.jpg",
    kind: "image",
    mime: "image/png",
    bytes: 67657,
    width: 800,
    height: 830,
    description:
      "A receipt from Corner Market, 418 Elm Street, Springfield, dated Oct 24, 2026 4:12 PM, receipt #004817. Items: " +
      "Oat milk, 64 oz $4.29; Bananas, 2.1 lb @ 0.69/lb $1.45; Sourdough loaf $5.99; Eggs, dozen $3.89; Coffee beans, " +
      "12 oz $11.49. Subtotal $27.11, tax (8.25%) $2.24, total $29.35, paid by card ending 4242.",
    credit: RENDERED,
    prompts: ["Extract the store, date, every line item and the total as JSON."],
  },
  {
    id: "signup-screen",
    label: "Sign-up screen",
    src: "/docs-samples/signup-screen.png",
    thumb: "/docs-samples/thumbs/signup-screen.jpg",
    kind: "image",
    mime: "image/png",
    bytes: 63951,
    width: 1280,
    height: 800,
    description:
      "A 1280 x 800 sign-up screen for a fictional garden app, Sprout. Left: a green panel reading \"Grow your garden " +
      "plan in minutes.\" Right: a form with Full name, Email and Password fields (centers near x 900 and y 275, 356 " +
      "and 437), an unchecked \"I agree to the Terms and Privacy Policy\" checkbox (near 735, 486), a green Create " +
      "account button (near 900, 540), a Cancel button (near 900, 598) and a Sign in link (near 983, 648).",
    credit: RENDERED,
    prompts: ["Where would you click to create an account? Give x and y in pixels."],
  },
  {
    id: "field-report",
    label: "2-page PDF report",
    src: "/docs-samples/field-report.pdf",
    kind: "pdf",
    mime: "application/pdf",
    bytes: 67354,
    description:
      "\"Northwind Bikes: Q3 2026 Field Report\", 2 pages, for a fictional bike rental company. Page 1: rides grew 18% " +
      "over Q2 to 12,480; rides by station: Central Square 5,210 ($41,680), Riverside Park 4,130 ($37,170), Harbor, " +
      "opened Jul 14, 3,140 ($23,550), total $102,400; a fleet of 140 bikes, 36 electric. Page 2: the top three rider " +
      "complaints, three Q4 action items with owners and due dates, and a $58,000 Q4 budget.",
    credit: RENDERED,
    prompts: ["Summarize this report in three bullet points.", "Which station had the longest average ride?"],
  },
  {
    id: "street-pan",
    label: "Street clip (5 s)",
    src: "/docs-samples/street-pan.mp4",
    thumb: "/docs-samples/thumbs/street-pan.jpg",
    kind: "video",
    mime: "video/mp4",
    bytes: 300828,
    width: 1280,
    height: 720,
    durationMs: 5000,
    fps: 24,
    frames: 120,
    description:
      "A 5 second, 24 fps (120 frames), 1280 x 720 H.264 clip with no audio: a slow pan across the street photo, so " +
      "the woman, her two dogs and the bicycles slide from right to left across the frame.",
    credit: "Made with ffmpeg from the street photo (Muse Image), for Muse Muse.",
    prompts: ["dog", "bicycle", "Describe what happens in this video."],
  },
  {
    id: "speech-paragraph",
    label: "Spoken paragraph",
    src: "/docs-samples/speech-paragraph.wav",
    kind: "audio",
    mime: "audio/wav",
    bytes: 467110,
    durationMs: 14596,
    description:
      "One voice, 16 kHz mono 16-bit WAV, saying: \"Hi, this is a short test recording for Muse Voice Transcribe. Our " +
      "team at Acme Mobile is rolling out eSIM support on every 5G plan next week. Anaya will run the launch from " +
      "Kolkata, and the first status call is on Thursday at three thirty.\"",
    credit: "Spoken by the macOS voice Samantha (say), converted to 16 kHz mono WAV for Muse Muse.",
    prompts: ["Acme Mobile", "eSIM", "5G", "Anaya", "Kolkata"],
  },
  {
    id: "two-voices",
    label: "Two-voice call",
    src: "/docs-samples/two-voices.wav",
    kind: "audio",
    mime: "audio/wav",
    bytes: 809634,
    durationMs: 25300,
    description:
      "Two voices taking turns, 16 kHz mono 16-bit WAV. A (shop): \"Hi, thanks for calling Riverside Bikes. How can I " +
      "help?\" B (caller): \"Hi. The back brake on my bike is squeaking. Can I bring it in today?\" A: \"Sure. We're " +
      "open until six, and a brake tune-up takes about thirty minutes.\" B: \"Great. I'll come by around four. How much " +
      "does it cost?\" A: \"Twenty-five dollars, and that includes new pads if you need them.\" B: \"Perfect. See you at four.\"",
    credit: "Spoken by the macOS voices Samantha and Daniel (say), converted to 16 kHz mono WAV for Muse Muse.",
  },
  {
    id: "chess-moves",
    label: "Spoken chess moves",
    src: "/docs-samples/chess-moves.wav",
    kind: "audio",
    mime: "audio/wav",
    bytes: 292862,
    durationMs: 9151,
    description:
      "Four chess moves spoken with pauses between them, 16 kHz mono 16-bit WAV: \"Pawn to e4. Knight to f3. Bishop to " +
      "c4. Castle kingside.\"",
    credit: "Spoken by the macOS voice Daniel (say), converted to 16 kHz mono WAV for Muse Muse.",
    prompts: ["pawn", "knight", "bishop", "castle", "kingside"],
  },
  {
    id: "alice",
    label: "Alice in Wonderland, ch. 1 to 3",
    src: "/docs-samples/alice-chapters-1-3.txt",
    kind: "text",
    mime: "text/plain",
    bytes: 32842,
    description:
      "Chapters I to III of Alice's Adventures in Wonderland by Lewis Carroll (1865): about 6,000 words (roughly 8,000 " +
      "tokens) of public-domain text, for long-context and prompt-caching demos.",
    credit: "Lewis Carroll, public domain. Text from Project Gutenberg eBook #11, header, footer and license removed.",
    prompts: ["What does Alice drink, and what happens next?", "List every animal Alice meets in these chapters."],
  },
];

export function samplesOf(kind: SampleKind): DocsSample[] {
  return DOCS_SAMPLES.filter((s) => s.kind === kind);
}

export function sampleById(id: string): DocsSample | null {
  return DOCS_SAMPLES.find((s) => s.id === id) ?? null;
}
