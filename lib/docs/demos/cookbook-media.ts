import type { DemoMap } from "@/lib/docs/demos/types";
import { HeadlockedCaptions } from "@/components/docs/playgrounds/cookbook-media/HeadlockedCaptions";
import { ImageRecipe } from "@/components/docs/playgrounds/cookbook-media/ImageRecipe";
import { RecipeBrowser } from "@/components/docs/playgrounds/cookbook-media/RecipeBrowser";
import { SamBasics } from "@/components/docs/playgrounds/cookbook-media/SamBasics";
import { StickerPack } from "@/components/docs/playgrounds/cookbook-media/StickerPack";
import { TranscribeRecipe } from "@/components/docs/playgrounds/cookbook-media/TranscribeRecipe";
import { VoiceChess } from "@/components/docs/playgrounds/cookbook-media/VoiceChess";

/**
 * Live demos and coding-agent prompts for the "cookbook-media" pages:
 *   cookbook/muse-image
 *   cookbook/image-generation-basics
 *   cookbook/image-editing-with-reasoning
 *   cookbook/anchored-image-series
 *   cookbook/search-grounded-image-generation
 *   cookbook/muse-voice-transcribe
 *   cookbook/voice-api-fundamentals
 *   cookbook/voice-chess-cua
 *   cookbook/headlocked-speech-bubble-captions
 *   cookbook/sam
 *   cookbook/sam-api-basics
 *   cookbook/video-to-sticker-pack
 * Components live in components/docs/playgrounds/cookbook-media/. The Muse Image pages share ImageRecipe (steps of
 * one conversation), the three category pages share RecipeBrowser; the rest have a demo each. These recipes run on
 * muse-image-1.0, sam-3.1 and muse-voice-transcribe-1.0, which have one mode each, so no Contributor model is involved.
 *
 * The prompts stay well under the 4,000 characters a copy prompt may use, because "Include what I just ran" (on by
 * default) adds the reader's last request to them: render.test.tsx builds each one with a recorded run of every kind
 * the page's demo makes and checks that no section gets cut to fit.
 */

/** The art-style words the anchored series repeats in every prompt. */
const STYLE = "bold clean comic-book line art with thick black outlines, flat vivid colors";

const FOX = "a watercolor painting of a red fox sitting in a snowy pine forest, soft golden morning light";
const TAGS =
  "add a small handwritten price tag next to each item, like a piece of masking tape with a marker price: $120 on the cream sofa, " +
  "$45 on the round wooden coffee table, and $30 on the tripod floor lamp; keep the room and everything else unchanged";

// ---- Shared snippets ------------------------------------------------------------------------------------------

/** Python: one Muse Image turn that saves its image and returns the response and the image item. */
const PY_TURN = `import base64
import os
from pathlib import Path

from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])


def turn(out: str, **body):
    reply = client.responses.create(model="muse-image-1.0", **body)
    item = next(i for i in reply.output if i.type == "image_generation_call")
    Path(out).write_bytes(base64.b64decode(item.result))
    return reply, item
`;

/** A local image as a data URL, inline in Python. */
const pyDataUrl = (file: string) => `"data:image/jpeg;base64," + base64.b64encode(Path("${file}").read_bytes()).decode()`;

/** TypeScript: the same turn with the OpenAI SDK (it throws on HTTP errors). `read` adds readFile for local images. */
const tsTurn = (read: boolean) => `import OpenAI from "openai";
import { ${read ? "readFile, " : ""}writeFile } from "node:fs/promises";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });

async function turn(body: object, out: string) {
  const reply = await client.responses.create({ model: "muse-image-1.0", ...body } as never);
  const image = reply.output.find((o) => o.type === "image_generation_call") as { result: string };
  await writeFile(out, Buffer.from(image.result, "base64"));
  return reply;
}
`;

/** A local image as a data URL, inline in TypeScript. */
const tsDataUrl = (file: string) => `\`data:image/jpeg;base64,\${(await readFile("${file}")).toString("base64")}\``;

/** Two chained turns in curl: jq builds the second body, so the response id needs no shell quoting. */
const CURL_IMAGE = `curl -s https://api.meta.ai/v1/responses \\
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model": "muse-image-1.0", "input": "${FOX}"}' > turn1.json
jq -r '.output[] | select(.type == "image_generation_call") | .result' turn1.json | base64 --decode > fox.webp

# Refine: chain from turn 1 and send only the change.
jq -n --arg id "$(jq -r .id turn1.json)" '{model: "muse-image-1.0", previous_response_id: $id, input: "add a small red wool hat on its head"}' \\
  | curl -s https://api.meta.ai/v1/responses -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" -d @- \\
  | jq -r '.output[] | select(.type == "image_generation_call") | .result' | base64 --decode > fox_hat.webp`;

const VOICE_REQUEST = `{"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "DIARIZATION"}`;

export const cookbookMediaDemos: DemoMap = {
  // ---- Muse Image ---------------------------------------------------------------------------------------------
  "cookbook/muse-image": {
    title: "Find the Muse Image recipe you need",
    blurb: "Pick what you need, see which recipe covers it, how it works and what a full run costs, then run its first step here: one Muse Image call, $0.01.",
    Component: RecipeBrowser,
    props: {
      category: "Muse Image",
      needs: [
        { id: "basic", label: "Basic generation" },
        { id: "grounding", label: "Web grounding" },
        { id: "series", label: "Consistency across a series" },
        { id: "editing", label: "Multi-turn editing" },
      ],
      recipes: [
        {
          slug: "cookbook/image-generation-basics",
          title: "Generate, edit, and compose images",
          summary: "Generate an image, refine it across turns, or combine it with new reference images.",
          needs: ["basic", "editing"],
          time: "About 15 min",
          models: ["muse-image-1.0"],
          languages: "Python",
          flow: [
            "Turn 1: a text input on the Responses API returns an image_generation_call item; decode its base64 result.",
            "Refine: pass previous_response_id and send only the change; the prior image carries forward.",
            "Compose: input_text and input_image parts in one user message fuse references into one scene.",
            "Or carry the state yourself: store: false, replaying the prior image_generation_call item.",
          ],
          calls: "3 Muse Image calls, about $0.03",
          quick: { kind: "image", label: "Turn 1: the recipe's watercolor fox", prompt: FOX },
        },
        {
          slug: "cookbook/search-grounded-image-generation",
          title: "Ground image generation with web search",
          summary: "Use web references when an image should reflect current products, places, or styles. Verify factual details independently.",
          needs: ["grounding", "editing"],
          time: "About 20 min",
          models: ["muse-image-1.0"],
          languages: "Python",
          flow: [
            "Turn 1: the prompt asks Muse Image to search the web for real products, then render them as a product grid.",
            "Compose: chain from it and attach only the new photo as an input_image; the grid carries forward.",
            "Refine: another chained turn searches again and adds a matching piece.",
            "The API doesn't return what the search found: verify names, availability and details yourself.",
          ],
          calls: "3 Muse Image calls, about $0.03 (search is included in the image price)",
          quick: {
            kind: "image",
            label: "Turn 1: search for a real product and render it",
            prompt:
              "Search the web for a currently sold modern rattan outdoor lounge armchair with white cushions. Render it as a clean e-commerce product shot on a plain white background, catalog style, faithful to the real product's frame, proportions and cushions.",
          },
        },
        {
          slug: "cookbook/anchored-image-series",
          title: "Keep an image series consistent",
          summary: "Use reference images to improve character, style, and setting consistency across a series. Compare each output with the references.",
          needs: ["series"],
          time: "About 25 min",
          models: ["muse-image-1.0"],
          languages: "Python",
          flow: [
            "Build the anchors first: character sheets and clean setting plates, each a turn chained into one conversation.",
            "Render each panel as a chained turn that names the anchors and repeats the art-style words.",
            "Compose the panels into a page with a layout-only turn, then letter it in one more turn.",
            "Compare every panel with the anchors and regenerate the ones that drift.",
          ],
          calls: "4 anchors, 6 panels and 2 page turns at $0.01 each: about $0.12",
          quick: {
            kind: "image",
            label: "The first anchor: an original hero character sheet",
            prompt: `an original comic-book superhero character sheet, a stylized man wearing a bright green flowing cape and a green eye mask, dark hair, muscular build, confident heroic pose, plain white background, full body centered, ${STYLE}`,
          },
        },
        {
          slug: "cookbook/image-editing-with-reasoning",
          title: "Edit image details across turns",
          summary: "Edit one part of a photo, then refine the result across turns. Check that unchanged areas still match the source.",
          needs: ["editing"],
          time: "About 15 min",
          models: ["muse-image-1.0"],
          languages: "Python",
          flow: [
            "Turn 1: upload the photo as an input_image next to the instruction, naming each item and its change.",
            "Later turns: previous_response_id plus one instruction that says what changes and what stays.",
            "Compare each result with the source to catch changes in areas that should stay the same.",
          ],
          calls: "2 Muse Image calls, about $0.02",
          quick: { kind: "image", label: "Turn 1: price tags on the sample living room photo", referenceSampleId: "living-room", prompt: TAGS },
        },
      ],
    },
    agentPrompt: {
      task:
        "Pick the Muse Image recipe on this page that fits my project (basic generation, web-grounded product images, a consistent series, or editing a photo across turns), tell me which and why, then build its first two steps: a Responses call that generates or edits an image, and a chained follow-up with previous_response_id and only the change. Save each image and print each turn's usage.",
      facts: [
        "POST /v1/responses with model muse-image-1.0. The image is the base64 result of the output item with type image_generation_call: find it by type, since reasoning and message items can come first.",
        "previous_response_id carries the prior image forward: send only the change, never re-attach a prior render.",
        'Reference images are input_image parts (a public URL or a data URL) in one {"role": "user", "content": [...]} message after the input_text; a bare list of parts gets HTTP 400.',
        "With store: false nothing stays on the server: replay the prior image_generation_call item first in the next input instead.",
        "$0.01 per image, built-in search included; a turn takes 10 to 60 s. The OpenAI SDK doesn't read MODEL_API_KEY on its own: pass it.",
      ],
      checklist: [
        "Turn 1 is status completed, and its image_generation_call result decodes to an image file.",
        "The follow-up sends previous_response_id and a one-line change, and keeps what it didn't touch.",
        "Each turn's usage prints: input, cached, output and reasoning tokens.",
      ],
      snippets: {
        python: `${PY_TURN}

fox, _ = turn("fox.webp", input="${FOX}")
hat, _ = turn("fox_hat.webp", previous_response_id=fox.id, input="add a small red wool hat on the fox's head")
print(fox.usage, hat.usage, sep="\\n")`,
        typescript: `${tsTurn(false)}
const fox = await turn({ input: "${FOX}" }, "fox.webp");
const hat = await turn({ previous_response_id: fox.id, input: "add a small red wool hat on the fox's head" }, "fox_hat.webp");
console.log(fox.usage, hat.usage);`,
        curl: CURL_IMAGE,
      },
    },
  },

  "cookbook/image-generation-basics": {
    title: "Generate, refine and compose across turns",
    blurb:
      "Run the recipe's three turns on Muse Image: generate the fox, refine it with previous_response_id, then compose it with two reference photos, or carry the state yourself with store: false. $0.01 per image, about $0.03 for all three.",
    Component: ImageRecipe,
    props: {
      stateModes: true,
      bareList: true,
      steps: [
        {
          id: "generate",
          label: "Generate an image from a prompt",
          group: "turn",
          prompt: FOX,
          note: "Turn 1: a text input in, an image_generation_call out. Keep its response id: the next turns chain from it.",
        },
        {
          id: "refine",
          label: "Refine across turns",
          group: "turn",
          chainFrom: "generate",
          prompt: "add a small red wool hat on the fox's head, keep the snowy forest background",
          note: "Pass previous_response_id and describe only the change. The server carries the image forward, so input tokens grow while the request stays one short instruction.",
        },
        {
          id: "compose",
          label: "Steer and compose with reference images",
          group: "turn",
          chainFrom: "generate",
          references: [
            { sampleId: "cat-sofa", label: "Reference: the sofa and cat" },
            { sampleId: "sneaker", label: "Reference: the sneaker" },
          ],
          prompt:
            "combine into one watercolor scene: the fox from the previous image curled up on this grey sofa next to this sleeping ginger cat, with this sneaker on the floor in front of the sofa",
          note: "Chains from turn 1, as the recipe does, and attaches only the new images, as input_image parts in one user message. The options let you send them as a bare list to see the HTTP 400 the recipe warns about.",
        },
      ],
    },
    agentPrompt: {
      task:
        "Add Muse Image's core moves to my project on the Responses API: generate from a prompt, refine with previous_response_id and only the change, compose with reference images as input_image parts in one user message, and a store: false path that replays the prior image item. Save each image and print each turn's usage.",
      facts: [
        "POST /v1/responses, model muse-image-1.0. The image is the base64 result of the image_generation_call output item: find it by type, not position.",
        "Refine with previous_response_id and only the change.",
        'References go in one {"role": "user", "content": [input_text, input_image, ...]} message; a bare list gets HTTP 400.',
        "With store: false, replay the prior image_generation_call item first in the next input; its signed id carries the image.",
        "$0.01 per image.",
      ],
      checklist: [
        "Turn 1 completes and its result decodes to an image.",
        "The refine keeps the fox's pose and adds the hat.",
        "Two input_image parts in a user message compose; a bare list gets HTTP 400.",
        "The store: false path refines without previous_response_id.",
      ],
      snippets: {
        python: `${PY_TURN}

fox, prior = turn("fox.webp", input="a watercolor red fox in the snow")
mug = ${pyDataUrl("mug.jpg")}
turn("mug.webp", previous_response_id=fox.id, input=[{"role": "user", "content": [
    {"type": "input_text", "text": "the fox beside this mug"}, {"type": "input_image", "image_url": mug}]}])

# store=False: replay the item, no previous_response_id
ask = {"role": "user", "content": [{"type": "input_text", "text": "add a red wool hat"}]}
turn("hat.webp", store=False, input=[prior.model_dump(), ask])`,
        typescript: `${tsTurn(true)}
const fox = await turn({ input: "a watercolor red fox in a snowy forest" }, "fox.webp");
await turn({ previous_response_id: fox.id, input: "add a red wool hat" }, "hat.webp");
const mug = ${tsDataUrl("mug.jpg")};
await turn({ previous_response_id: fox.id, input: [{ role: "user", content: [
  { type: "input_text", text: "the fox beside this mug" }, { type: "input_image", image_url: mug }] }] }, "mug.webp");`,
        curl: CURL_IMAGE,
      },
    },
  },

  "cookbook/image-editing-with-reasoning": {
    title: "Edit a photo across turns, then check what changed",
    blurb:
      "Turn 1 adds price tags to the sample living room photo; turn 2 sells the sofa and marks the lamp down with previous_response_id. Compare each result with its source. $0.01 per image, about $0.02.",
    Component: ImageRecipe,
    props: {
      stateModes: true,
      compare: true,
      steps: [
        {
          id: "tag",
          label: "Turn 1: add a price tag to every item",
          references: [{ sampleId: "living-room", label: "Your photo" }],
          prompt: TAGS,
          note: "Upload the photo as an input_image next to the instruction, and bind each price to its item by name.",
        },
        {
          id: "update",
          label: "Turn 2: update the listing after a sale and a price cut",
          chainFrom: "tag",
          prompt:
            "the cream sofa has been sold: remove the sofa and its $120 tag entirely, leaving that spot as empty floor. the floor lamp has been marked down: change its tag to show the old price $30 with a line struck through it and the new price $18 next to it. keep the coffee table and its $45 tag unchanged",
          note: "One more turn with previous_response_id, no re-upload. Name what changes and what stays, then compare with turn 1 and with the source photo.",
        },
      ],
    },
    agentPrompt: {
      task:
        "Add photo editing across turns to my project with Muse Image: send a photo as an input_image with an instruction that names each item and its change, then apply a follow-up edit with previous_response_id and one new instruction. After each turn, compare the result with the source and report areas that changed but shouldn't have.",
      facts: [
        'POST /v1/responses, model muse-image-1.0. Turn 1\'s input: [{"role": "user", "content": [{"type": "input_text", ...}, {"type": "input_image", "image_url": "data:image/jpeg;base64,..."}]}].',
        "Later turns pass previous_response_id and only the new instruction; don't re-upload the image.",
        "Name each item and its change, and say what stays (keep the lamp and its $25 tag). Prices are drawn text: re-run a turn when one is unclear.",
        "For real items for sale, ask the model to keep their true condition and review before publishing.",
        "store: false works too: replay the prior image_generation_call item first. $0.01 per image.",
      ],
      checklist: [
        "Turn 1 adds one tag per named item and changes nothing else.",
        "Turn 2 chains by id, removes the sold item, strikes the old price next to the new one, and keeps the rest.",
        "A pixel diff against the source shows changes only where the instruction asked.",
      ],
      snippets: {
        python: `${PY_TURN}

photo = ${pyDataUrl("items.jpg")}
tagged, _ = turn("tagged.webp", input=[{"role": "user", "content": [
    {"type": "input_text", "text": "add a handwritten price tag by each item: $25 lamp, $80 guitar, $15 books; keep the rest unchanged"},
    {"type": "input_image", "image_url": photo}]}])
updated, _ = turn("updated.webp", previous_response_id=tagged.id,
                  input="the guitar sold: remove it and its tag. show $15 struck through with $8 on the books. keep the lamp's tag")
print(tagged.usage, updated.usage, sep="\\n")`,
        typescript: `${tsTurn(true)}
const photo = ${tsDataUrl("items.jpg")};
const tagged = await turn({ input: [{ role: "user", content: [
  { type: "input_text", text: "add a handwritten price tag by each item: $25 lamp, $80 guitar, $15 books; keep the rest unchanged" },
  { type: "input_image", image_url: photo },
] }] }, "tagged.webp");
await turn({ previous_response_id: tagged.id, input: "the guitar sold: remove it and its tag. show $15 struck through with $8 on the books" }, "updated.webp");`,
        curl: `IMG=$(base64 < items.jpg | tr -d '\\n')
curl -s https://api.meta.ai/v1/responses \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "muse-image-1.0", "input": [{"role": "user", "content": [
        {"type": "input_text", "text": "add a small handwritten price tag next to each item; keep everything else unchanged"},
        {"type": "input_image", "image_url": "data:image/jpeg;base64,'"$IMG"'"}]}]}' > turn1.json
jq -r '.output[] | select(.type == "image_generation_call") | .result' turn1.json | base64 --decode > tagged.webp`,
      },
    },
  },

  "cookbook/anchored-image-series": {
    title: "Build anchors, chain panels, compose a page",
    blurb:
      "Run the recipe's chain on Muse Image: hero and cat character sheets and a park plate as anchors, two panels that continue from them, then the composed page. $0.01 per image: about $0.06 for these six; two optional steps letter the page and show the scene without anchors.",
    Component: ImageRecipe,
    props: {
      sheet: true,
      steps: [
        {
          id: "hero",
          label: "Anchor: the hero character sheet",
          group: "anchor",
          prompt: `an original comic-book superhero character sheet, a stylized man wearing a bright green flowing cape and a green eye mask, dark hair, muscular build, confident heroic pose, plain white background, full body centered, ${STYLE}`,
          note: "Describe the original subject precisely on a plain background, so later turns have a clean target to lock onto.",
        },
        {
          id: "cat",
          label: "Anchor: the cat character sheet",
          group: "anchor",
          chainFrom: "hero",
          prompt: `an original comic-book cat character sheet, a small orange tabby kitten with bold darker orange tiger stripes and a distinctive white chest and white paws, big round eyes, sitting alert, plain white background, centered, ${STYLE}`,
          note: "The cat appears in both panels and on the page, so it gets its own sheet: anchor every recurring element, not just the hero.",
        },
        {
          id: "park",
          label: "Anchor: the park plate",
          group: "anchor",
          chainFrom: "cat",
          prompt: `comic-book style background illustration of a sunny public park with one large prominent climbable tree in the center, green grass, a path, benches, no characters, no people, ${STYLE}`,
          note: "A setting with no characters, chained into the same conversation as the hero and the cat.",
        },
        {
          id: "panel1",
          label: "Panel 1: the hero arrives",
          group: "panel",
          chainFrom: "park",
          prompt: `in the park with the big tree shown earlier: the cat shown earlier sitting on a high branch of the tree, people below pointing up at it, the hero shown earlier arriving and looking up at the cat, ${STYLE}, no speech bubbles, no text, single comic panel`,
          note: "Chains from the last anchor, so the hero, the cat and the park are already in the conversation: name each one and repeat the style words.",
        },
        {
          id: "panel2",
          label: "Panel 2: the rescue",
          group: "panel",
          chainFrom: "panel1",
          prompt: `the hero climbing the tree branches to bring the cat shown earlier down safely, reaching for it, action pose, ${STYLE}, no speech bubbles, no text, single comic panel`,
        },
        {
          id: "page",
          label: "Compose the page",
          group: "page",
          chainFrom: "panel2",
          prompt:
            "Arrange the two comic panels into one portrait comic-book page. Place each panel as-is and keep its artwork unchanged; do not redraw, restyle, or duplicate any panel. Top: the hero arriving below the cat in the tree, full width. Bottom: the rescue, full width. Clean black borders and white gutters between panels.",
          note: "Layout only: the panels already live in the conversation, so nothing is uploaded.",
        },
        {
          id: "letter",
          label: "Letter the page",
          group: "page",
          chainFrom: "page",
          optional: true,
          prompt:
            'Add speech bubbles to this comic page. Keep the layout and all the artwork exactly as it is; only add clean white comic speech bubbles with bold black outlines and short uppercase lettering. Place each bubble in an empty part of its panel so no character, face, or animal is covered, and give each bubble a tail that points to the speaker. In the top panel the hero says "HANG ON!"; in the bottom panel the hero says "GOT YOU, LITTLE ONE!". Add no other text.',
          note: "One more chained turn letters the clean page, so each line lands on empty space with its tail on the speaker.",
        },
        {
          id: "unanchored",
          label: "Without anchors: the same scene from scratch",
          group: "compare",
          chainFrom: null,
          optional: true,
          prompt: `a green caped superhero in a park looking up at a small orange tabby cat sitting on a high branch of a big tree, ${STYLE}, no speech bubbles, no text, single comic panel`,
          note: "Why anchoring matters: no previous_response_id, so the costume, face and style are free to change. Compare it with panel 1 in the contact sheet.",
        },
      ],
    },
    agentPrompt: {
      task:
        "Build an anchored image series in my project with Muse Image: the anchors first (a character sheet per recurring character, a plate per setting) as chained turns in one conversation, then each panel as a turn that continues with previous_response_id and names the anchors, then a page composed from the panels and lettered. Save every image and a contact sheet.",
      facts: [
        "Every call is POST /v1/responses, model muse-image-1.0; the image is the image_generation_call item's base64 result.",
        "Chaining keeps the series consistent: each turn passes the previous response's id, so the conversation holds every anchor. An unchained call starts from nothing and drifts.",
        "Anchor every recurring element, not just the hero (a cat in several panels gets its own sheet): characters on plain backgrounds, settings with no characters.",
        "Name each subject (the cat shown earlier) and repeat the art-style words in every prompt; keep panels text-free, compose the layout in one turn and letter it in another.",
        "Later turns carry more input tokens: chain only the anchors and beats you need. $0.01 per image.",
      ],
      checklist: [
        "The anchors (hero, cat, setting) and every panel come from one chain of turns.",
        "Every panel shows the anchored hero, cat and setting; panels that drift are regenerated.",
        "The page holds the panels as rendered, and lettering only adds bubbles.",
      ],
      snippets: {
        python: `${PY_TURN}
STYLE = "${STYLE}"

hero, _ = turn("hero.webp", input=f"an original superhero character sheet, green cape, white background, {STYLE}")
cat, _ = turn("cat.webp", previous_response_id=hero.id, input=f"an original cat character sheet, an orange tabby, white background, {STYLE}")
park, _ = turn("park.webp", previous_response_id=cat.id, input=f"a sunny park with one big tree, no people, {STYLE}")
p1, _ = turn("p1.webp", previous_response_id=park.id, input=f"the hero shown earlier in that park, looking up at the cat shown earlier in the tree, {STYLE}, no text")
p2, _ = turn("p2.webp", previous_response_id=p1.id, input=f"the hero climbing the tree to rescue the cat shown earlier, {STYLE}, no text")
turn("page.webp", previous_response_id=p2.id, input="Arrange the two panels into one portrait page, each as-is")`,
        typescript: `${tsTurn(false)}
const STYLE = "${STYLE}";
const step = (input: string, prev: { id: string } | null, out: string) => turn(prev ? { previous_response_id: prev.id, input } : { input }, out);

const hero = await step(\`a superhero character sheet, green cape, white background, \${STYLE}\`, null, "hero.webp");
const cat = await step(\`a cat character sheet, an orange tabby, white background, \${STYLE}\`, hero, "cat.webp");
const park = await step(\`a sunny park with one big tree, no people, \${STYLE}\`, cat, "park.webp");
const p1 = await step(\`the hero shown earlier in that park, looking up at the cat shown earlier in the tree, \${STYLE}, no text\`, park, "p1.webp");
await step("Arrange the panels into one portrait page, each as-is.", p1, "page.webp");`,
        curl: `turn() { # $1 the prompt, $2 the previous response id ("" for none), $3 the output name
  jq -n --arg p "$1" --arg prev "$2" '{model: "muse-image-1.0", input: $p} + (if $prev == "" then {} else {previous_response_id: $prev} end)' \\
    | curl -s https://api.meta.ai/v1/responses -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" -d @- > "$3.json"
  jq -r '.output[] | select(.type == "image_generation_call") | .result' "$3.json" | base64 --decode > "$3.webp"
  jq -r .id "$3.json"
}
STYLE="${STYLE}"
HERO=$(turn "an original superhero character sheet, green cape and eye mask, plain white background, $STYLE" "" hero)
CAT=$(turn "an original cat character sheet, a small orange tabby kitten, plain white background, $STYLE" "$HERO" cat)
PARK=$(turn "a sunny park with one big tree, no characters, no people, $STYLE" "$CAT" park)
turn "the hero shown earlier in the park shown earlier, looking up at the cat shown earlier in the tree, $STYLE, no text" "$PARK" panel1`,
      },
    },
  },

  "cookbook/search-grounded-image-generation": {
    title: "Research, render, compose, refine",
    blurb:
      "Run the recipe's three turns on Muse Image: search the web and render a product grid, compose it into the sample living room, then search again to add a matching piece. $0.01 per image with search included: about $0.03.",
    Component: ImageRecipe,
    props: {
      searchSwitches: true,
      caution:
        "Muse Image can search the web before it renders, but the API doesn't return what it found: verify product names, availability and visual details yourself before you use an image.",
      steps: [
        {
          id: "research",
          label: "Research and render the set",
          prompt:
            "Search the web for a coordinated mid-century modern accent armchair and matching side table sold today as one collection, in green velvet with walnut legs. Render a clean e-commerce product grid with one cell per piece: the armchair and the side table each shown individually on a plain white background, catalog style, each piece by itself and not combined into a room scene. Each rendered piece should be a faithful reproduction of the real product you find in the search, matching its frame, proportions, materials and color.",
          note: "Turn 1 is text to image with a search first. Each piece on its own stays faithful when it's composed later.",
        },
        {
          id: "compose",
          label: "Compose into the room",
          chainFrom: "research",
          references: [{ sampleId: "living-room", label: "The room photo" }],
          prompt:
            "Place the items from the product grid into this living room as one reading corner beside the window. Keep the room exactly as in the photo: do not change or move the sofa, coffee table, rug, lamp, plants or window. Only add the furniture, matching the existing daylight and shadows.",
          note: "Chain from the grid and attach only the new photo: the pieces carry forward.",
        },
        {
          id: "refine",
          label: "Refine with another search",
          chainFrom: "compose",
          prompt:
            "Search the web for a matching velvet footstool from the same collection, then add it in front of the new armchair. Keep everything else unchanged: do not alter the room or move the existing furniture. Only add the footstool, matching the existing daylight and shadows.",
          note: "Refinement is one more turn, and it can search too. Repeat the guard that leaves the room untouched.",
        },
      ],
    },
    agentPrompt: {
      task:
        "Build search-grounded product visualization in my project with Muse Image: a turn that asks the model to search the web for real products and render them as a product grid, a chained turn that attaches only the room photo and places the pieces in it, and a refine turn that searches again. Tell the user to verify the products.",
      facts: [
        "POST /v1/responses, model muse-image-1.0. It searches when the prompt asks; don't add a web_search tool (only image_generation is accepted, others get HTTP 400).",
        'Search is on by default and in the $0.01 per image; tools: [{"type": "image_generation", "enable_web_search": false}] turns it off.',
        "The reply has no search results or citations: verify names, availability and details yourself.",
        "Chain with previous_response_id; attach only new images, in one user message, and say what each is. Pin a product by maker, SKU or URL when it matters.",
      ],
      checklist: [
        "Turn 1 returns a product grid, one piece per cell.",
        "The compose turn sends only the room photo, and the room stays as it was.",
        "The refine turn adds one searched piece without moving the others.",
      ],
      snippets: {
        python: `${PY_TURN}

grid, _ = turn("set.webp", input="Search the web for a rattan lounge set sold today. Render a product grid, one piece per cell.")
deck = ${pyDataUrl("backyard.jpg")}
placed, _ = turn("restyled.webp", previous_response_id=grid.id, input=[{"role": "user", "content": [
    {"type": "input_text", "text": "Place the items from the grid onto this deck. Keep the backyard as it is."},
    {"type": "input_image", "image_url": deck}]}])
turn("refined.webp", previous_response_id=placed.id, input="Search the web for a matching coffee table and add it.")`,
        typescript: `${tsTurn(true)}
const grid = await turn({ input: "Search the web for a rattan lounge set sold today. Render a product grid." }, "set.webp");
const deck = ${tsDataUrl("backyard.jpg")};
const placed = await turn({ previous_response_id: grid.id, input: [{ role: "user", content: [
  { type: "input_text", text: "Place the items from the grid onto this deck. Keep the backyard as it is." },
  { type: "input_image", image_url: deck }] }] }, "restyled.webp");
await turn({ previous_response_id: placed.id, input: "Search the web for a matching coffee table; add it." }, "refined.webp");`,
        curl: `curl -s https://api.meta.ai/v1/responses \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "muse-image-1.0", "input": "Search the web for a coordinated modern rattan outdoor lounge set sold today. Render a product grid, one piece per cell on white.",
       "tools": [{"type": "image_generation", "enable_web_search": true}]}' \\
  | jq -r '.output[] | select(.type == "image_generation_call") | .result' | base64 --decode > set.webp`,
      },
    },
  },

  // ---- Muse Voice Transcribe ----------------------------------------------------------------------------------
  "cookbook/muse-voice-transcribe": {
    title: "Find the Muse Voice Transcribe recipe you need",
    blurb: "See what each voice recipe builds, which endpoint and mode it uses, and run its first step here on a sample: one transcription, well under a cent.",
    Component: RecipeBrowser,
    props: {
      category: "Muse Voice Transcribe",
      needs: [
        { id: "file", label: "Transcribe a recording" },
        { id: "live", label: "Live microphone" },
        { id: "speakers", label: "Who said what" },
        { id: "commands", label: "Voice commands" },
      ],
      recipes: [
        {
          slug: "cookbook/voice-api-fundamentals",
          title: "Speech to text",
          summary:
            "Transcribe a recording or a live microphone over the streaming WebSocket, get speaker-attributed turns with diarization, or post a whole recording in one HTTP request.",
          needs: ["file", "live", "speakers"],
          time: "About 10 min",
          models: ["muse-voice-transcribe-1.0"],
          languages: "Python",
          flow: [
            "Stream a recording over wss://api.meta.ai/v1/asr/realtime at real-time pace: cumulative partials, then final: true.",
            "Dictate from a microphone in ENDPOINTING mode, where the model finds where each turn starts and ends.",
            "Diarize with DIARIZATION: each turn runs speechStart, partials, speaker, speechEnd and speechComplete.",
            "Or POST the whole recording to /v1/asr/transcribe and read transcript and turns.",
          ],
          calls: "$0.18 per hour of audio, streaming or not",
          quick: { kind: "transcribe", label: "One request in DIARIZATION mode on the two-voice call", sampleId: "two-voices", mode: "DIARIZATION" },
        },
        {
          slug: "cookbook/voice-chess-cua",
          title: "Control Apple Chess with voice",
          summary:
            "Turn exact spoken chess moves into locally validated Apple Chess actions with a passive HUD, calibrated grid, dry-run mode, and fail-closed native input.",
          needs: ["commands", "live"],
          time: "About 10 min",
          models: ["muse-voice-transcribe-1.0"],
          languages: "Python, on macOS with Apple Chess",
          flow: [
            "Muse Voice Transcribe streams partials for the HUD and finished speech turns, with vocabulary biasing.",
            'A deterministic local parser accepts only the exact phrase "Move A1 to B2", with no second model call.',
            "A macOS computer-use layer validates the Chess window, posts two clicks and confirms the move; anything unclear posts nothing.",
          ],
          calls: "$0.18 per hour of audio",
          quick: {
            kind: "transcribe",
            label: "Transcribe the spoken chess moves, biased toward them",
            sampleId: "chess-moves",
            keywords: ["Pawn to e4", "Knight to f3", "Bishop to c4", "Castle kingside"],
          },
        },
      ],
    },
    agentPrompt: {
      task:
        "Pick the Muse Voice Transcribe recipe on this page that fits my project (transcribing recordings and live speech with speaker turns, or exact voice commands), tell me which and why, then build its core: send a mono 16-bit WAV to POST /v1/asr/transcribe as a two-part multipart request and print the transcript and any speaker turns.",
      facts: [
        "File transcription: POST https://api.meta.ai/v1/asr/transcribe, multipart with a request part (JSON with model muse-voice-transcribe-1.0, audioEncoding WAV, and optional mode, keywords, languageBias) and an audio part.",
        "Only mono 16-bit PCM WAV at 16 or 24 kHz is accepted; convert first (ffmpeg -i in.mp3 -ac 1 -ar 24000 -sample_fmt s16 out.wav).",
        'Modes: PUSH_TO_TALK (the default), ENDPOINTING, DIARIZATION. Speaker labels are bare letters ("A"); skip turns with an empty transcript.',
        "Live speech uses wss://api.meta.ai/v1/asr/realtime: the credential travels in the first (handshake) frame, and audio must be paced at real time.",
        "$0.18 per hour of audio, billed in whole seconds. One request takes up to 10 minutes or 32 MB of audio.",
      ],
      checklist: [
        "A WAV file transcribes and the transcript prints.",
        "With mode DIARIZATION, the turns print with their speaker letters and start times.",
        "Other formats are converted to WAV first, and a 400's message is shown.",
      ],
      snippets: {
        python: `import json
import os

import requests

with open("interview.wav", "rb") as audio:
    res = requests.post(
        "https://api.meta.ai/v1/asr/transcribe",
        headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
        files={
            "request": (None, json.dumps(${VOICE_REQUEST})),
            "audio": ("interview.wav", audio, "audio/wav"),
        },
    )
res.raise_for_status()
reply = res.json()
print(reply["transcript"].strip())
for turn in reply.get("turns", []):
    if turn.get("transcript"):
        print(f"[{turn['startMs'] / 1000:7.2f}s] {turn.get('speaker', '?')}: {turn['transcript']}")`,
        typescript: `import { readFile } from "node:fs/promises";

const form = new FormData();
form.append("request", JSON.stringify(${VOICE_REQUEST}));
form.append("audio", new Blob([await readFile("interview.wav")], { type: "audio/wav" }), "interview.wav");
const res = await fetch("https://api.meta.ai/v1/asr/transcribe", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\` },
  body: form,
});
if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);
const reply = await res.json();
for (const t of reply.turns ?? []) if (t.transcript) console.log(\`[\${(t.startMs / 1000).toFixed(2)}s] \${t.speaker}: \${t.transcript}\`);`,
        curl: `curl -s https://api.meta.ai/v1/asr/transcribe \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F 'request=${VOICE_REQUEST}' \\
  -F "audio=@interview.wav;type=audio/wav" | jq '{transcript, turns}'`,
      },
    },
  },

  "cookbook/voice-api-fundamentals": {
    title: "Stream, dictate, diarize, or send one request",
    blurb:
      "Pick a step of the recipe and run it on a sample or your microphone: realtime partials and turns through the docs relay, or one asr/transcribe request. $0.18 per hour of audio, well under a cent a run. The second tab simulates the cutoff rules.",
    Component: TranscribeRecipe,
    props: {
      simulator: true,
      presets: [
        {
          label: "Stream a recording",
          note: "transcribe_stream.py sample.wav: the WAV streamed at real-time pace in PUSH_TO_TALK. The cumulative partials replace each other in place, then final: true ends the stream.",
          props: { endpoints: ["realtime", "transcribe"], sampleId: "speech-paragraph", mode: "PUSH_TO_TALK", partialMode: "CUMULATIVE" },
        },
        {
          label: "Dictate from a microphone",
          note: "transcribe_stream.py --mic: ENDPOINTING, so the model finds where each turn starts and ends, and no pacer, since a microphone already runs at real time. Here, switch the audio source to Microphone, record a few sentences with pauses, then Stream: the docs relay sends the recording at real-time pace after you stop, so the partials and turns arrive as they would live, just not while you speak.",
          props: { endpoints: ["realtime", "transcribe"], sampleId: "speech-paragraph", mode: "ENDPOINTING" },
        },
        {
          label: "Diarization",
          note: "--mode DIARIZATION on the stream: each turn runs speechStart, partials, speaker, speechEnd and speechComplete. A speaker event labels the span before it, and speechComplete can arrive late, so turns are matched by turnId.",
          props: { endpoints: ["realtime", "transcribe"], sampleId: "two-voices", mode: "DIARIZATION" },
        },
        {
          label: "One request",
          note: "transcribe_file.py --mode DIARIZATION: one POST to asr/transcribe with the key in the Authorization header and no pacing. The reply has the whole transcript plus turns with bare speaker letters.",
          props: { endpoints: ["transcribe", "realtime"], sampleId: "two-voices", mode: "DIARIZATION" },
        },
        {
          label: "Bias the transcription",
          note: "--keywords and --language-bias: lists of strings that nudge the model rather than constrain it. The sample says Anaya, Kolkata, Acme Mobile and eSIM.",
          props: {
            endpoints: ["transcribe", "realtime"],
            sampleId: "speech-paragraph",
            mode: "PUSH_TO_TALK",
            keywords: ["Anaya", "Kolkata", "Acme Mobile", "eSIM"],
            languageBias: ["english"],
          },
        },
      ],
    },
    agentPrompt: {
      task:
        "Add speech to text to my project both ways: a client for wss://api.meta.ai/v1/asr/realtime that sends the handshake, paces PCM on an absolute schedule, redraws cumulative partials and prints each finished turn with its speaker; and an uploader for POST /v1/asr/transcribe. Both take --mode, --keywords and --language-bias.",
      facts: [
        "Audio: mono 16-bit WAV at 24 or 16 kHz; stream its raw PCM (PCM_24KHZ or PCM_16KHZ), upload the WAV.",
        'The stream\'s first frame carries the key, model and mode (as in the code); end with {"type": "endStream"}.',
        "transcript events are cumulative: replace the line. A speaker event labels the span before it; speechComplete ends a turn (match by turnId).",
        "1008: no handshake in 10 s, over 5 s of backlog, or 10 s below real time (pad silence). 1011: past 60 min. 1013: rate limited.",
      ],
      checklist: [
        "Streaming a WAV redraws one line in place.",
        "--mode DIARIZATION prints turns under [A] and [B].",
        "The upload prints [start] speaker: text; a 10-minute file streams with no 1008.",
      ],
      snippets: {
        python: `import asyncio, json, os, time, wave

import websockets


async def stream(path, mode="DIARIZATION"):
    with wave.open(path, "rb") as w:
        rate, pcm = w.getframerate(), w.readframes(w.getnframes())
    step = int(rate * 0.08) * 2  # 80 ms
    hello = {"authorization": {"accessToken": f"Bearer {os.environ['MODEL_API_KEY']}"}, "model": "muse-voice-transcribe-1.0",
             "mode": mode, "audioEncoding": f"PCM_{rate // 1000}KHZ"}
    async with websockets.connect("wss://api.meta.ai/v1/asr/realtime") as ws:
        await ws.send(json.dumps(hello))

        async def send():
            t0 = time.monotonic()
            for n, i in enumerate(range(0, len(pcm), step)):
                await asyncio.sleep(max(0, t0 + n * 0.08 - time.monotonic()))  # absolute schedule
                await ws.send(pcm[i : i + step])
            await ws.send(json.dumps({"type": "endStream"}))

        sender = asyncio.create_task(send())
        async for raw in ws:
            msg = json.loads(raw)
            kind = msg.get("type")
            if kind == "transcript":  # cumulative
                print("\\r\\033[K" + msg["transcript"], end="", flush=True)
            elif kind == "speaker":
                print(f"\\r\\033[K[{msg['label']}]")
            elif kind == "speechComplete":
                print(f"\\r\\033[Kturn {msg['turnId']}: {msg['transcript']}")
        await sender


asyncio.run(stream("meeting.wav"))`,
        typescript: `import { readFile } from "node:fs/promises";

// The one-shot endpoint: the whole recording in one multipart request.
const form = new FormData();
form.append("request", JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "DIARIZATION", keywords: ["Anaya", "Kolkata"] }));
form.append("audio", new Blob([await readFile("interview.wav")], { type: "audio/wav" }), "interview.wav");
const res = await fetch("https://api.meta.ai/v1/asr/transcribe", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\` },
  body: form,
});
if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);
const { transcript, turns = [] } = await res.json();
console.log(transcript.trim());
for (const t of turns) if (t.transcript) console.log(\`[\${(t.startMs / 1000).toFixed(2).padStart(7)}s] \${t.speaker}: \${t.transcript}\`);`,
        curl: `ffmpeg -i input.mp3 -ac 1 -ar 24000 -sample_fmt s16 interview.wav
curl -s https://api.meta.ai/v1/asr/transcribe \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F 'request={"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "DIARIZATION", "languageBias": ["english"]}' \\
  -F "audio=@interview.wav;type=audio/wav" | jq '.turns[] | {startMs, speaker, transcript}'`,
      },
    },
  },

  "cookbook/voice-chess-cua": {
    title: "Speak chess moves onto a board",
    blurb:
      'Listen streams the sample through Muse Voice Transcribe with keyword biasing, and each finished turn goes through the recipe\'s exact parser and the board\'s rules before anything moves. The sample\'s piece names fail closed; Plus piece moves plays them, and "Move E2 to E4" passes as is. Under a cent; typing is free.',
    Component: VoiceChess,
    props: {
      sampleId: "chess-moves",
      keywordSets: [
        { label: "The sample's moves", keywords: ["Pawn to e4", "Knight to f3", "Bishop to c4", "Castle kingside"] },
        { label: "Piece names", keywords: ["Move", "Pawn", "Knight", "Bishop", "Rook", "Queen", "King", "Castle", "kingside", "queenside"] },
        { label: "None", keywords: [] },
      ],
      grammar: "exact",
      autoReply: true,
      endpoint: "realtime",
      phrases: [
        "Move E2 to E4",
        "move g1 to f3.",
        "Move E 2 to E 4",
        "Move E two to E four",
        "Please move E2 to E4",
        "Move E2 to E2",
        "Knight to d2",
        "Castle kingside",
      ],
    },
    agentPrompt: {
      task:
        'Build voice chess moves in my project as this recipe does: stream microphone audio to wss://api.meta.ai/v1/asr/realtime in ENDPOINTING mode with keyword biasing, show partials in a HUD only, and pass each finished turn to a deterministic local parser that accepts only "Move A1 to B2". Validate the move against the position before acting, fail closed on anything unparseable or illegal, and add --dry-run.',
      facts: [
        "Handshake: the key, model muse-voice-transcribe-1.0, mode ENDPOINTING (the model finds turn boundaries) and keywords. Realtime access may be limited during rollout.",
        "Grammar: a case-insensitive full match of Move <file><rank> to <file><rank>, an optional trailing period, files A to H, ranks 1 to 8, two different squares. Don't repair spacing, convert spoken ranks (E two) or lift a move out of other words.",
        "Only speechComplete may act; partial, stale, duplicate and superseded events never do, and audio heard while a move runs is dropped.",
        "Revalidate right before acting and confirm after; never retry input. There's no wake phrase: start in dry run. $0.18 per audio hour.",
      ],
      checklist: [
        'Saying "Move E2 to E4" plays it once, and the HUD shows VOICE, TURN and HEARD.',
        '"Move E 2 to E 4", "Move E two to E four" and "please move E2 to E4" are rejected and nothing runs.',
        "An illegal move is rejected before any input, --dry-run never acts, and unit tests cover every rejection.",
      ],
      snippets: {
        python: `import re

MOVE = re.compile(r"move ([a-h][1-8]) to ([a-h][1-8])\\.?", re.IGNORECASE)


def parse_move(transcript: str) -> tuple[str, str] | None:
    """The exact grammar or nothing: no repairs, no partial matches."""
    m = MOVE.fullmatch(transcript.replace("\\u200b", "").strip())
    if not m or m[1].lower() == m[2].lower():
        return None
    return m[1].lower(), m[2].lower()


assert parse_move("Move E2 to E4.") == ("e2", "e4")
for bad in ["Move E 2 to E 4", "Move E two to E four", "please move E2 to E4", "Move E2 to E2"]:
    assert parse_move(bad) is None


def on_message(msg: dict, board, dry_run: bool) -> None:
    if msg.get("type") != "speechComplete":  # only a finished turn may act; partials feed the HUD
        return
    move = parse_move(msg.get("transcript", ""))
    if move is None or not board.is_legal(*move):
        print("rejected, nothing posted:", msg.get("transcript"))
    elif dry_run:
        print("dry run, would play:", move)
    else:
        board.play(*move)`,
        typescript: `const MOVE = /^move ([a-h][1-8]) to ([a-h][1-8])\\.?$/i;

/** The exact grammar or nothing: no repairs, no partial matches. */
export function parseMove(transcript: string): [string, string] | null {
  const m = MOVE.exec(transcript.replace(/\\u200b/g, "").trim());
  if (!m || m[1].toLowerCase() === m[2].toLowerCase()) return null;
  return [m[1].toLowerCase(), m[2].toLowerCase()];
}

const handled = new Set<number>();
export function onMessage(msg: { type?: string; turnId?: number; transcript?: string }, board: { isLegal(a: string, b: string): boolean; play(a: string, b: string): void }) {
  // Only a finished turn may act, once; partials only update the HUD.
  if (msg.type !== "speechComplete" || msg.turnId === undefined || handled.has(msg.turnId)) return;
  handled.add(msg.turnId);
  const move = parseMove(msg.transcript ?? "");
  if (!move || !board.isLegal(...move)) return console.log("rejected, nothing posted:", msg.transcript);
  board.play(...move);
}`,
        curl: `# A recorded move through the one-shot endpoint, biased toward the grammar's words:
curl -s https://api.meta.ai/v1/asr/transcribe \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F 'request={"model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV", "mode": "ENDPOINTING", "keywords": ["Move", "E2", "E4"]}' \\
  -F "audio=@move.wav;type=audio/wav" | jq -r .transcript`,
      },
    },
  },

  // ---- Segment Anything ---------------------------------------------------------------------------------------
  "cookbook/headlocked-speech-bubble-captions": {
    title: "Match voices to people and caption them",
    blurb:
      'Analyze runs Muse Voice diarization on the two-voice call and SAM 3.1 "people" on the street photo or the uploaded clip in parallel; match each voice to a person, then play the call with speech bubbles over whoever is talking. Under a cent for the photo, about $0.024 for the clip.',
    Component: HeadlockedCaptions,
    props: {
      audioSampleId: "two-voices",
      imageSampleId: "street",
      videoSampleId: "street-pan",
      media: ["image", "video"],
      concept: "people",
      maxWords: 7,
    },
    agentPrompt: {
      task:
        'Build headlocked captions in my project: on my server, run Muse Voice Transcribe (DIARIZATION) on a video\'s audio and SAM 3.1 "people" on the uploaded video in parallel; let the user match each speaker letter to a person; then draw bubbles that follow the speaker\'s head, keep a side and avoid other people. Export with the original audio.',
      facts: [
        "Keep keys on the server, which calls the API.",
        "Voices: asr/transcribe in DIARIZATION mode on a mono 16-bit WAV; skip turns with no transcript.",
        'People: POST /v1/files (purpose=user_data), then a streamed sam-3.1 call: input_text "people", input_video by file_id, metadata {"mask_encoding": "one_bit"}.',
        "Drop tiny people by area ratio, not by describing clothing.",
        "SAM video $0.20 per 1,000 frames, 50 minimum; voice $0.18 per audio hour.",
      ],
      checklist: [
        "Both analyses run in parallel, with progress for each.",
        "Each speaker maps to a person; their bubble shows only while they talk.",
        "Bubbles never cover a face and follow their person; the MP4 keeps the original audio.",
      ],
      snippets: {
        typescript: `import OpenAI from "openai";
import { parseVideoStream, recordsOfKind } from "@meta-sam/parser";
import { openAsBlob } from "node:fs";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });

async function voices(wav: string) {
  const form = new FormData();
  form.append("request", JSON.stringify(${VOICE_REQUEST}));
  form.append("audio", await openAsBlob(wav, { type: "audio/wav" }), "audio.wav");
  const res = await fetch("https://api.meta.ai/v1/asr/transcribe", { method: "POST", headers: { Authorization: \`Bearer \${client.apiKey}\` }, body: form });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).turns.filter((t: { transcript: string }) => t.transcript);
}

async function people(mp4: string) {
  const file = await client.files.create({ file: new File([await openAsBlob(mp4)], "in.mp4"), purpose: "user_data" });
  const content = [{ type: "input_text", text: "people" }, { type: "input_video", file_id: file.id }] as never;
  const stream = await client.responses.create({ model: "sam-3.1", stream: true, metadata: { mask_encoding: "one_bit" }, input: [{ role: "user", content }] });
  return recordsOfKind((await parseVideoStream(stream).finalResult).records, "mask");
}

const [turns, masks] = await Promise.all([voices("audio.wav"), people("in.mp4")]);`,
        python: `import asyncio, json, os

import httpx
from meta_sam_parser import decode_mask_to_raster, parse_responses_stream, video_segmentation_format
from openai import AsyncOpenAI

client = AsyncOpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])


async def voices(wav):
    async with httpx.AsyncClient(timeout=600) as http:
        res = await http.post("https://api.meta.ai/v1/asr/transcribe", headers={"Authorization": f"Bearer {client.api_key}"},
                              data={"request": json.dumps(${VOICE_REQUEST})}, files={"audio": ("a.wav", open(wav, "rb"), "audio/wav")})
    res.raise_for_status()
    return [t for t in res.json()["turns"] if t["transcript"]]


async def people(mp4):
    upload = await client.files.create(file=open(mp4, "rb"), purpose="user_data")
    stream = await client.responses.create(model="sam-3.1", stream=True, metadata={"mask_encoding": "one_bit"}, input=[{"role": "user", "content": [
        {"type": "input_text", "text": "people"}, {"type": "input_video", "file_id": upload.id}]}])
    result = await parse_responses_stream(stream, video_segmentation_format()).final_result()
    return [(m, decode_mask_to_raster(m.mask)) for m in result.records if m.kind == "mask"]


async def main():
    turns, masks = await asyncio.gather(voices("audio.wav"), people("input.mp4"))  # in parallel

asyncio.run(main())`,
        curl: `curl -s https://api.meta.ai/v1/asr/transcribe -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F 'request=${VOICE_REQUEST}' -F "audio=@audio.wav;type=audio/wav" > transcript.json &
FILE=$(curl -s https://api.meta.ai/v1/files -H "Authorization: Bearer $MODEL_API_KEY" -F purpose=user_data -F "file=@input.mp4" | jq -r .id)
curl -sN https://api.meta.ai/v1/responses -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model": "sam-3.1", "stream": true, "metadata": {"mask_encoding": "one_bit"}, "input": [{"role": "user", "content": [{"type": "input_text", "text": "people"}, {"type": "input_video", "file_id": "'"$FILE"'"}]}]}' > people.sse
wait`,
      },
    },
  },

  "cookbook/sam": {
    title: "Find the SAM recipe you need",
    blurb: "See what each Segment Anything recipe builds and run its first step here: one segmentation on a sample, $0.0025 for a photo or about $0.024 for the 5 second clip.",
    Component: RecipeBrowser,
    props: {
      category: "SAM",
      needs: [
        { id: "image", label: "Segment an image" },
        { id: "video", label: "Track through video" },
        { id: "cutout", label: "Cut out a subject" },
        { id: "speech", label: "Pair people with speech" },
      ],
      recipes: [
        {
          slug: "cookbook/sam-api-basics",
          title: "SAM API basics",
          summary: "Segment an image or an uploaded video in Python or TypeScript, streaming the response and parsing it with the official meta-sam parsers.",
          needs: ["image", "video"],
          time: "About 15 min",
          models: ["sam-3.1"],
          languages: "Python and TypeScript",
          flow: [
            "Image: a local image as a data URL in an input_image part, the response streamed and parsed.",
            "Video: the MP4 uploaded with purpose=user_data, referenced as input_video by file_id, cumulative frames and tracks parsed.",
            "One short noun phrase per request; more concepts are more requests, with the summaries combined.",
            "Output: summary.json (boxes, decoded masks, track ranges) and an SVG per mask.",
          ],
          calls: "$2.50 per 1,000 images; video $0.20 per 1,000 frames, 50 frames minimum",
          quick: { kind: "sam", label: 'Segment "dog" in the street photo, streamed', sampleId: "street", prompt: "dog", media: "image" },
        },
        {
          slug: "cookbook/video-to-sticker-pack",
          title: "Video to animated stickers",
          summary: "Track an animal through a clip, cut the background from its longest-lived track, and export transparent animated stickers.",
          needs: ["video", "cutout"],
          time: "About 15 min",
          models: ["sam-3.1"],
          languages: "JavaScript and Python",
          flow: [
            "FFmpeg limits the longest edge while keeping every frame.",
            "SAM tracks every match of one noun (dog, cat) through the uploaded clip.",
            "The longest-lived track is cut out with its masks and a smoothed crop.",
            "The highest-motion window in each third becomes a 512 x 512 animated WebP sticker under 500 KB.",
          ],
          calls: "One SAM video request, billed per frame",
          quick: { kind: "sam", label: 'Track "dog" through the 5 second street clip', sampleId: "street-pan", prompt: "dog", media: "video" },
        },
        {
          slug: "cookbook/headlocked-speech-bubble-captions",
          title: "Multi-speaker headlocked captions",
          summary: "Match diarized voices to SAM-tracked people, preview collision-aware speech bubbles, and download the captioned video.",
          needs: ["video", "speech"],
          time: "About 20 min",
          models: ["sam-3.1", "muse-voice-transcribe-1.0"],
          languages: "React, TypeScript, JavaScript and Python",
          flow: [
            "Muse Voice diarization and one SAM request for people run in parallel.",
            "The user matches each voice to a tracked person.",
            "Bubbles anchor at the top of the speaker's mask, keep a stable side and avoid other people.",
            "Python, Pillow and FFmpeg render the captioned MP4 with the original audio.",
          ],
          calls: "One SAM video request plus one diarized transcription",
          quick: { kind: "sam", label: "Find the people in the street photo", sampleId: "street", prompt: "people", media: "image" },
        },
      ],
    },
    agentPrompt: {
      task:
        "Pick the Segment Anything recipe on this page that fits my project (segmenting images or video, cutting a subject out into stickers, or pairing tracked people with speech), tell me which and why, then build its first step: one streamed SAM 3.1 request for a short noun phrase on an image or an uploaded video, parsed into boxes, masks and tracks with Meta's parser.",
      facts: [
        "POST https://api.meta.ai/v1/responses with model sam-3.1 and stream true. The user message holds input_text (one short noun phrase, not a question) and input_image (a data URL or file_id) or input_video (a file_id from POST /v1/files with purpose=user_data).",
        "The result is output_text with box and mask tokens per frame: parse it with @meta-sam/parser (parseImageStream, parseVideoStream) or meta_sam_parser (parse_responses_stream) rather than by hand.",
        "A completed request with no masks is a valid empty match. Fail clearly on HTTP errors, refusals, failed or incomplete responses and malformed records.",
        "Images cost $2.50 per 1,000; video $0.20 per 1,000 frames with a 50-frame minimum per request (usage.video_frames_processed).",
      ],
      checklist: [
        "A noun phrase on an image returns one box and one mask per match.",
        "An uploaded video streams frames whose object ids stay stable across frames.",
        "A concept that isn't there is reported as an empty match, not an error.",
      ],
      snippets: {
        typescript: `import OpenAI from "openai";
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import { readFile } from "node:fs/promises";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const image = \`data:image/jpeg;base64,\${(await readFile("ducks.jpg")).toString("base64")}\`;
const stream = await client.responses.create({
  model: "sam-3.1",
  stream: true,
  input: [{ role: "user", content: [{ type: "input_text", text: "duck" }, { type: "input_image", image_url: image, detail: "auto" }] }],
});
const result = await parseImageStream(stream).finalResult;
if (result.outcome.status !== "completed") throw new Error(\`incomplete: \${JSON.stringify(result.outcome)}\`);
for (const m of recordsOfKind(result.records, "mask")) {
  const pixels = decodeMaskToRaster(m.mask).reduce((n, v) => n + v, 0);
  console.log(m.objectId, m.bounds, pixels);
}`,
        python: `import asyncio, base64, os

from meta_sam_parser import decode_mask_to_raster, image_segmentation_format, parse_responses_stream
from openai import AsyncOpenAI

client = AsyncOpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])


async def main() -> None:
    with open("ducks.jpg", "rb") as f:
        image = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
    stream = await client.responses.create(model="sam-3.1", stream=True, input=[{"role": "user", "content": [
        {"type": "input_text", "text": "duck"}, {"type": "input_image", "image_url": image}]}])
    result = await parse_responses_stream(stream, image_segmentation_format()).final_result()
    masks = [r for r in result.records if r.kind == "mask"]
    print(result.outcome.status, len(masks), "masks")  # zero masks is a valid empty match
    for m in masks:
        print(m.object_id, m.bounds, sum(decode_mask_to_raster(m.mask)), "pixels")

asyncio.run(main())`,
        curl: `curl -sN https://api.meta.ai/v1/responses \\
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model": "sam-3.1", "stream": true, "input": [{"role": "user", "content": [
        {"type": "input_text", "text": "dog"},
        {"type": "input_image", "image_url": "data:image/jpeg;base64,'"$(base64 < street.jpg | tr -d '\\n')"'"}]}]}'`,
      },
    },
  },

  "cookbook/sam-api-basics": {
    title: "Segment an image and an uploaded video",
    blurb:
      "Segment sends the street photo as a data URL, or uploads the clip with purpose=user_data and references its file_id, one streamed request per noun phrase, parsed into the recipe's summary.json and SVG masks. $0.0025 per photo request, about $0.024 per clip request.",
    Component: SamBasics,
    props: { media: ["image", "video"], imageSampleId: "street", videoSampleId: "street-pan", concepts: "dog, bicycle", videoConcepts: "dog", maskEncoding: "lossless" },
    agentPrompt: {
      task:
        "Add SAM 3.1 segmentation to my project as this recipe's two scripts do: a local image as a data URL, and an MP4 uploaded with purpose=user_data and referenced by file_id. Stream each request, parse it with Meta's parser, one request per noun phrase, and write summary.json and an SVG per mask. Accept --concept (repeatable), --output and --file-id.",
      facts: [
        "POST /v1/responses, model sam-3.1, stream true; one user message: input_text (a short noun phrase) and input_image (data URL) or input_video (file_id).",
        "Upload a video with POST /v1/files (purpose=user_data); --file-id reuses an upload.",
        "A mask's raster is its box's size; the parser's decode functions turn it into pixels or an SVG path.",
        "Fail clearly on HTTP errors, refusals and incomplete responses; zero masks is a valid empty match. Images $2.50 per 1,000; video $0.20 per 1,000 frames.",
      ],
      checklist: [
        '--concept duck writes summary.json with a mask per duck and prints "Wrote 1 result(s) and N mask(s)".',
        "The video run uploads once, or reuses --file-id.",
        "Two --concept flags make two requests; an absent concept is an empty match.",
      ],
      snippets: {
        typescript: `import OpenAI from "openai";
import { decodeMaskToRaster, decodeMaskToSVGPath, frameIndexOf, parseVideoStream, recordsOfKind } from "@meta-sam/parser";
import { readFile, writeFile } from "node:fs/promises";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const upload = await client.files.create({ file: new File([await readFile("pingpong.mp4")], "pingpong.mp4"), purpose: "user_data" });
const stream = await client.responses.create({
  model: "sam-3.1",
  stream: true,
  input: [{ role: "user", content: [{ type: "input_text", text: "ping pong ball" }, { type: "input_video", file_id: upload.id }] as never }],
});
const result = await parseVideoStream(stream).finalResult;
const masks = recordsOfKind(result.records, "mask");
const summary = {
  concept: "ping pong ball",
  outcome: result.outcome.status,
  masks: masks.map((m) => ({ object_id: m.objectId, frame: frameIndexOf(m) ?? null, foreground_pixels: decodeMaskToRaster(m.mask).reduce((n, v) => n + v, 0) })),
};
await writeFile("summary.json", JSON.stringify([summary], null, 2));
await writeFile("mask-0.svg", \`<svg xmlns="http://www.w3.org/2000/svg"><path d="\${decodeMaskToSVGPath(masks[0].mask)}"/></svg>\`);`,
        python: `import asyncio, json, os
from pathlib import Path

from meta_sam_parser import decode_mask_to_raster, decode_mask_to_svg_path, parse_responses_stream, video_segmentation_format
from openai import AsyncOpenAI

client = AsyncOpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])


async def segment(concept, file_id):
    stream = await client.responses.create(model="sam-3.1", stream=True, input=[{"role": "user", "content": [
        {"type": "input_text", "text": concept}, {"type": "input_video", "file_id": file_id}]}])
    result = await parse_responses_stream(stream, video_segmentation_format()).final_result()
    masks = [r for r in result.records if r.kind == "mask"]
    for i, m in enumerate(masks):
        Path(f"mask-{i}.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg"><path d="{decode_mask_to_svg_path(m.mask)}"/></svg>')
    return {"concept": concept, "outcome": result.outcome.status,
            "masks": [{"object_id": m.object_id, "frame": m.frame.frame_index, "pixels": sum(decode_mask_to_raster(m.mask))} for m in masks]}


async def main():
    upload = await client.files.create(file=open("pingpong.mp4", "rb"), purpose="user_data")
    summary = [await segment(c, upload.id) for c in ["ping pong ball"]]  # a request per noun phrase
    Path("summary.json").write_text(json.dumps(summary, indent=2))

asyncio.run(main())`,
        curl: `FILE=$(curl -s https://api.meta.ai/v1/files -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F purpose=user_data -F "file=@pingpong.mp4" | jq -r .id)
curl -sN https://api.meta.ai/v1/responses \\
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model": "sam-3.1", "stream": true, "input": [{"role": "user", "content": [
        {"type": "input_text", "text": "ping pong ball"},
        {"type": "input_video", "file_id": "'"$FILE"'"}]}]}'`,
      },
    },
  },

  "cookbook/video-to-sticker-pack": {
    title: "Track a dog and make animated stickers",
    blurb:
      "SAM 3.1 tracks every dog through the uploaded street clip; your browser cuts the longest-lived track out with its masks, picks the busiest window in each third and encodes three transparent animated WebP stickers with GIF previews to download. About $0.024 for the clip's 120 frames.",
    Component: StickerPack,
    props: { videoSampleId: "street-pan", concept: "dog", size: 512, maxFps: 15, maxSeconds: 2.5, maxBytes: 512000 },
    agentPrompt: {
      task:
        "Build the video-to-sticker pipeline in my project: upload a clip, ask SAM 3.1 for one noun (dog, cat), take the longest-lived track (or --track-id), cut each frame out with its mask and a smoothed crop, and export the busiest window of each third as a 512 x 512 transparent animated WebP under 500 KB, with GIF previews and report.json.",
      facts: [
        "Upload with POST /v1/files (purpose=user_data); segment with a streamed sam-3.1 call: input_text the noun, input_video by file_id, metadata.mask_encoding one_bit. Parse with Meta's parser.",
        "Ids are stable and frame indexes are source frames: keep every frame when preprocessing (cap only the longest edge).",
        "A mask's raster is its box's size; decoded, it is 0 or 1 per pixel, for alpha. Score motion on the cutout.",
        "Stickers: 512 x 512, at most 15 fps, about 2.5 s, under 500 KB. No other model runs after SAM.",
        "Save the raw events so --events re-runs with no API call. Video: $0.20 per 1,000 frames, 50 minimum.",
      ],
      checklist: [
        "A pet clip gives sticker-01.webp to sticker-03.webp: 512 x 512, transparent, animated, under 500 KB.",
        "The longest-lived track is the default; --track-id picks another.",
        "--events rebuilds the pack with no API call; report.json lists the source frames.",
      ],
      snippets: {
        typescript: `import OpenAI from "openai";
import { decodeMaskToRaster, frameIndexOf, parseVideoStream, recordsOfKind } from "@meta-sam/parser";
import { readFile } from "node:fs/promises";

const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });
const upload = await client.files.create({ file: new File([await readFile("shiba_jump.mp4")], "shiba_jump.mp4"), purpose: "user_data" });
const stream = await client.responses.create({
  model: "sam-3.1",
  stream: true,
  metadata: { mask_encoding: "one_bit" },
  input: [{ role: "user", content: [{ type: "input_text", text: "dog" }, { type: "input_video", file_id: upload.id }] as never }],
});
const masks = recordsOfKind((await parseVideoStream(stream).finalResult).records, "mask");

// The longest-lived track: the object present in the most frames.
const frames = new Map<string, Set<number>>();
for (const m of masks) frames.set(m.objectId, (frames.get(m.objectId) ?? new Set()).add(frameIndexOf(m) ?? 0));
const [trackId] = [...frames.entries()].sort((a, b) => b[1].size - a[1].size)[0];
for (const m of masks.filter((x) => x.objectId === trackId)) {
  const alpha = decodeMaskToRaster(m.mask); // 0 or 1 per pixel of m.bounds, on source frame frameIndexOf(m)
  void alpha;
}`,
        python: `import asyncio, json, os
from collections import Counter

from meta_sam_parser import decode_mask_to_raster, parse_responses_stream, video_segmentation_format
from openai import AsyncOpenAI

client = AsyncOpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])


async def main():
    upload = await client.files.create(file=open("shiba_jump.mp4", "rb"), purpose="user_data")
    stream = await client.responses.create(model="sam-3.1", stream=True, metadata={"mask_encoding": "one_bit"}, input=[
        {"role": "user", "content": [{"type": "input_text", "text": "dog"}, {"type": "input_video", "file_id": upload.id}]}])
    log = open("events.ndjson", "w")

    async def saved():
        async for event in stream:
            log.write(json.dumps(event.model_dump()) + "\\n")
            yield event

    result = await parse_responses_stream(saved(), video_segmentation_format()).final_result()
    masks = [r for r in result.records if r.kind == "mask"]
    track = Counter(m.object_id for m in masks).most_common(1)[0][0]  # the longest-lived track
    for m in (m for m in masks if m.object_id == track):
        alpha = decode_mask_to_raster(m.mask)  # 0 or 1 per pixel of m.bounds

asyncio.run(main())`,
        curl: `FILE=$(curl -s https://api.meta.ai/v1/files -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F purpose=user_data -F "file=@shiba_jump.mp4" | jq -r .id)
# Save the raw events so later runs can reuse them (the recipe's --events):
curl -sN https://api.meta.ai/v1/responses \\
  -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \\
  -d '{"model": "sam-3.1", "stream": true, "metadata": {"mask_encoding": "one_bit"}, "input": [{"role": "user", "content": [
        {"type": "input_text", "text": "dog"}, {"type": "input_video", "file_id": "'"$FILE"'"}]}]}' \\
  | sed -n 's/^data: //p' > events.ndjson`,
      },
    },
  },
};
