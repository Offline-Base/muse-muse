# Keep an image series consistent {#keep-an-image-series-consistent}

|                      |                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [Muse Image](https://dev.meta.ai/docs/cookbook/muse-image)                                                                 |
| **Time to complete** | \~25 min                                                                                                                   |
| **Model**            | `muse-image-1.0`                                                                                                           |
| **Language**         | Python                                                                                                                     |
| **Prerequisites**    | Python 3.10+, the `openai` package, and a `MODEL_API_KEY` (create one in the [Model API dashboard](https://dev.meta.ai/)). |

Use reference images when a series repeats a character, style, or setting. References can improve consistency, but compare every output with the source images.

The worked example creates a six-panel comic with one hero, two locations, and a cat. The same sequence applies to product shots, avatars, storyboards, and brand assets.

The reference anchors (a hero character sheet, two location plates, and a cat character sheet) and the composed page:

![A hero character sheet, a city street plate, a park plate, and a cat character sheet shown side by side as the reference anchors](https://dev.meta.ai/docs-assets/anchored-image-series/00_reference_row.webp)

![A six-panel portrait comic page composed and lettered by Muse Image: a wide city establishing panel on top, the warning and a tall flight panel next, the cat-in-the-tree beat, and the rescue and interview on the bottom row, each carrying a speech bubble](https://dev.meta.ai/docs-assets/anchored-image-series/page_model.webp)

*Images throughout are from an actual run; because the model is non-deterministic, your results will differ.*

## Why anchoring matters {#why-anchoring-matters}

An unchained generation has no prior image context. Ask twice for "a green caped hero in a park" and the costume, face, or art style can change. Generate the hero once, then keep later turns in the same conversation so each turn can use that reference.

The same scene, generated two ways. On the left, a plain text-to-image call with no reference: a generic hero in a generic style. On the right, the same prompt anchored on the hero and park references: the established character, in the established setting.

![A generic green caped hero from a text prompt without a reference](https://dev.meta.ai/docs-assets/anchored-image-series/bad_no_ref.webp)

![The established hero generated with the character and park reference images](https://dev.meta.ai/docs-assets/anchored-image-series/good_with_ref.webp)

Without the reference, the character has a different mask, suit, and build. With the reference, the mask, costume, and face more closely match the original hero. Create references first, then reuse them in each related generation.

Create a reference for each recurring character, setting, or style.

## How it works {#how-it-works}

Muse Image is reached through the **Responses API** (`client.responses.create`). A generation turn returns a response with an `id`, a `status`, and an `output` list; the rendered image is the base64 `result` on the `image_generation_call` item in that list.

Anchoring works by chaining. Each generation is a turn in a conversation, and passing `previous_response_id` on the next turn gives the model everything the conversation already holds, including the images it rendered earlier. So once you generate the hero as its own turn, every later turn that chains from it can reuse that hero by name, with no re-upload and no re-description. This cookbook builds all four anchors as generated turns, then chains every panel back to them. (If an anchor lives in a file instead of the conversation, for example art you made elsewhere, you can attach it once as an `input_image` part on the turn that needs it; here everything is generated in-conversation, so chaining alone carries it.)

The recipe puts that to work as **reference anchors for consistency**: build the hero, the cat, and the two settings once, up front, then render the six panels by chaining from those anchor turns. The panels accumulate in the conversation too, so the last two steps arrange the panels the conversation already holds into a page and then letter it.

![The anchoring workflow: text prompts to responses.create produce the reference anchors (hero, cat, city and park plates), chained into one conversation; each panel turn chains from the anchors and sets its size, rendering an on-model panel; a compose turn arranges the panels the conversation already holds into a clean page; a final turn letters that page with the speech bubbles](https://dev.meta.ai/docs-assets/anchored-image-series/00_flow.webp)

Swap the vocabulary and the pattern carries over: a product plus a set of scenes, an avatar plus poses, a brand kit plus templates. The anchors change; the technique does not.

## Setup {#setup}

Install the dependency and set your key:

```bash
pip install openai
export MODEL_API_KEY="LLM|..."
```

Wire up the client once. The OpenAI SDK does not auto-read `MODEL_API_KEY`, so pass it explicitly. Add one helper to pull the rendered image out of the response's `output` list and one to save it to disk:

```python
import base64
import os

from openai import OpenAI

# The OpenAI SDK does not auto-read MODEL_API_KEY, so pass it explicitly.
client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)


def image_b64(response) -> str:
    """Return the base64 image from the image_generation_call item in the output."""
    return next(
        item.result
        for item in response.output
        if item.type == "image_generation_call"
    )


def save_image(b64: str, path: str) -> None:
    """Decode a base64 image from the API and write it to disk."""
    with open(path, "wb") as f:
        f.write(base64.b64decode(b64))
    print(f"saved {path}")
```

## Build the reference anchors {#build-the-reference-anchors}

The anchors are the foundation: build them first, in one conversation, so they are all on hand when the panels begin. Each anchor turn chains from the previous one with `previous_response_id`, threading the hero, the cat, and both settings into a single conversation the panels then continue. Anchor **every recurring element**, not just the protagonist: any character or setting that shows up in more than one frame gets its own reference so it stays consistent. Map the story first, then build the full set. This comic needs four anchors: the caped hero (in every panel), the city street and the park (each in several panels), and a rescued cat (stuck in a tree, grabbed mid-rescue, then held during the interview). Characters get character-sheet prompts; locations get clean, character-free background plates.

Describe each **original** subject precisely, on a plain background, so later renders have a clean, well-defined target to lock onto. Generate the hero and the cat as character sheets:

```python
STYLE = (
    "bold clean comic-book line art with thick black outlines, flat vivid "
    "colors"
)

hero = client.responses.create(
    model="muse-image-1.0",
    input=(
        "an original comic-book superhero character sheet, a stylized man "
        "wearing a bright green flowing cape and a green eye mask, dark hair, "
        "muscular build, confident heroic pose, plain white background, full "
        f"body centered, {STYLE}"
    ),
)
save_image(image_b64(hero), "hero.webp")

cat = client.responses.create(
    model="muse-image-1.0",
    previous_response_id=hero.id,
    input=(
        "an original comic-book cat character sheet, a small orange tabby "
        "kitten with bold darker orange tiger stripes and a distinctive white "
        "chest and white paws, big round eyes, sitting alert, plain white "
        f"background, centered, {STYLE}"
    ),
)
save_image(image_b64(cat), "cat.webp")
```

Then build the two location plates the same way. Prompt for the setting only, no characters, so each background is a clean plate to drop the hero and cat into:

```python
bg_city = client.responses.create(
    model="muse-image-1.0",
    previous_response_id=cat.id,
    input=(
        "comic-book style background illustration of an ordinary city street "
        "on a bright day, sidewalks, storefronts, lamp posts, no characters, "
        f"no people, {STYLE}"
    ),
)
save_image(image_b64(bg_city), "bg_city.webp")

bg_park = client.responses.create(
    model="muse-image-1.0",
    previous_response_id=bg_city.id,
    input=(
        "comic-book style background illustration of a sunny public park with "
        "one large prominent climbable tree in the center, green grass, a "
        f"path, benches, no characters, no people, {STYLE}"
    ),
)
save_image(image_b64(bg_park), "bg_park.webp")
```

That is the whole reference set: the hero and the cat character sheets, and the city and park location plates, all now in the conversation for the panels to draw on.

![An original caped comic-book hero character sheet on a white background](https://dev.meta.ai/docs-assets/anchored-image-series/01_hero.webp)

![Comic-style empty city street with storefronts and lamp posts](https://dev.meta.ai/docs-assets/anchored-image-series/02_bg_city.webp)

![Comic-style empty park with one large climbable tree in the center](https://dev.meta.ai/docs-assets/anchored-image-series/03_bg_park.webp)

![An original comic-book cat character sheet, an orange tabby with a white chest and dark stripes, on a white background](https://dev.meta.ai/docs-assets/anchored-image-series/00_cat_anchor.webp)

## Generate the panels from the anchors {#generate-the-panels-from-the-anchors}

Render each panel as a chained turn. Pass `previous_response_id` so every panel continues the conversation that contains the hero, cat, and settings. Refer to each subject by name and repeat the art-style words in every prompt. Compare each panel with the references before continuing.

Leave the panels free of speech bubbles for now. Rendering clean art first, then lettering the composed page in a later step, keeps each line under your control and off the characters' faces.

```python
STYLE = (
    "bold clean comic-book line art with thick black outlines, flat vivid "
    "colors"
)


def panel(prompt, prev, out):
    """Render one chained panel, continuing from the previous turn."""
    response = client.responses.create(
        model="muse-image-1.0",
        previous_response_id=prev,
        input=f"{prompt}, {STYLE}, no speech bubbles, no text, single comic panel",
    )
    save_image(image_b64(response), out)
    return response


# Panel 1: establish the hero on the city street. Chains from the last anchor,
# so the hero and the city plate are already in the conversation.
city = panel(
    "the hero walking down the city street shown earlier, relaxed confident "
    "stride",
    bg_park.id,
    "01_panel_city.webp",
)

# Panel 2: the coffee-shop owner raises the alarm.
store = panel(
    "close-up of a coffee shop storefront on the same city street: a frightened "
    "shop owner in an apron points urgently to the right, the hero turning to "
    "look",
    city.id,
    "02_panel_store.webp",
)

# Panel 3: the hero takes to the air. A tall, dramatic beat.
fly = panel(
    "the hero flying dramatically upward over the city rooftops, dynamic "
    "low-angle worms-eye view, cape streaming, strong speed lines",
    store.id,
    "03_panel_fly.webp",
)

# Panel 4: the cat and park, both generated as anchors, are already in the
# conversation, so just name them.
tree = panel(
    "in the park with the big tree shown earlier: the cat shown earlier clinging "
    "high in the tree branches, worried onlookers below pointing up, the hero "
    "arriving and looking up toward the cat",
    fly.id,
    "04_panel_tree.webp",
)

# Panel 5: the rescue.
rescue = panel(
    "the hero dynamically leaping and climbing the tree branches to rescue the "
    "cat, reaching for it, action pose",
    tree.id,
    "05_panel_rescue.webp",
)

# Panel 6: the interview. Square, to frame the hero and the reporter side by side.
interview = panel(
    "the hero standing in the park by the tree, smiling and holding the cat, a "
    "female news reporter on the right holding a microphone interviewing him",
    rescue.id,
    "06_panel_interview.webp",
)
```

In this run, the six panels kept the main costume, locations, and cat appearance close to the references. Compare each panel with the anchor images. Regenerate or refine any panel whose recurring elements differ.

![The caped hero walking down a city street](https://dev.meta.ai/docs-assets/anchored-image-series/01_panel_city.webp)

![A frightened coffee shop owner pointing while the hero turns to look](https://dev.meta.ai/docs-assets/anchored-image-series/02_panel_store.webp)

![A tall, low-angle panel of the hero flying over the rooftops](https://dev.meta.ai/docs-assets/anchored-image-series/03_panel_fly.webp)

![The hero looking up at the orange tabby cat in a park tree while onlookers point up](https://dev.meta.ai/docs-assets/anchored-image-series/04_panel_tree.webp)

![The hero climbing the tree and reaching for the orange tabby cat](https://dev.meta.ai/docs-assets/anchored-image-series/05_panel_rescue.webp)

![A reporter interviewing the smiling hero as he holds the orange tabby cat](https://dev.meta.ai/docs-assets/anchored-image-series/06_panel_interview.webp)

Because every turn chains from the last, the conversation grows as you go, and each turn re-sends the context before it. That is what holds the hero and the cat on-model without any re-upload, and it means later turns carry more context than earlier ones. Keep a series to the anchors and beats it actually needs rather than letting the chain run on.

## Compose the page {#compose-the-page}

The six panels already live in the conversation. Pass the interview response ID as `previous_response_id`, then describe the portrait layout. The model can arrange the panels without another upload.

Keep the instruction to layout only: give the portrait orientation and the row order, tell it to place each panel as-is, and let the model size the cells and draw the borders. The panels are still free of speech bubbles, so there is nothing to preserve or move yet. The model is only arranging art.

```python
clean_page = client.responses.create(
    model="muse-image-1.0",
    previous_response_id=interview.id,
    input=(
        "Arrange the six comic panels into one portrait comic-book page. Place "
        "each panel as-is and keep its artwork unchanged; do not redraw, "
        "restyle, or duplicate any panel.\n"
        "Row 1: the hero in town, full width.\n"
        "Middle: a left column and a right column. The left column stacks two "
        "panels: the shop owner warning the hero on top, and the cat in the "
        "tree below. The right column is the single tall hero-flying panel, "
        "spanning the full height of both left panels.\n"
        "Bottom row: the rescue on the left and the interview on the right.\n"
        "Clean black borders and white gutters between panels."
    ),
)
save_image(image_b64(clean_page), "07_page_clean.webp")
```

![A six-panel portrait comic page composed by Muse Image with no speech bubbles yet: a wide city establishing panel across the top, the warning beat and a tall hero-flying panel in the middle, the cat-in-the-tree beat, and the rescue and interview on the bottom row, with black borders and gutters](https://dev.meta.ai/docs-assets/anchored-image-series/07_page_clean.webp)

## Letter the page {#letter-the-page}

Now add the speech bubbles, in one more chained turn from the clean page. Name each line's speaker, and ask for the bubbles to sit in empty parts of their panels so no face or animal is covered:

```python
page = client.responses.create(
    model="muse-image-1.0",
    previous_response_id=clean_page.id,
    input=(
        "Add speech bubbles to this comic page. Keep the layout and all the "
        "artwork exactly as it is; only add clean white comic speech bubbles "
        "with bold black outlines and short uppercase lettering. Place each "
        "bubble in an empty part of its panel so no character, face, or animal "
        "is covered, and give each bubble a tail that points to the speaker. "
        "Add these bubbles:\n"
        "- In the panel with the shop owner and the hero: the shop owner in the "
        'apron says "HELP! A CAT\'S STUCK!"\n'
        "- In the tall panel of the hero flying over the city: the hero says "
        '"ON MY WAY!"\n'
        "- In the panel with the cat in the tree and the hero on the ground: "
        'the hero says "HANG ON!"\n'
        "- In the panel where the hero climbs the tree reaching the cat: the "
        'hero says "GOTCHA, LITTLE ONE!"\n'
        "- In the panel with the reporter and the hero holding the cat: the "
        'female reporter on the right says "HOW DID YOU DO IT?"\n'
        "Add no bubble to the opening street panel and add no other text."
    ),
)
save_image(image_b64(page), "page_model.webp")
```

![A portrait comic page composed and lettered by Muse Image: a wide city establishing panel across the top, the shop owner warning the hero and a tall hero-flying panel in the middle, the cat in the tree, and the rescue and interview on the bottom row, each panel carrying its speech bubble with the tail pointing to the speaker](https://dev.meta.ai/docs-assets/anchored-image-series/page_model.webp)

The first turn lays out the panels, and the second adds lettering. Compare the final page with the clean composition and the reference images.

## Check the result {#check-the-result}

Compare every panel with the reference images. Regenerate or refine a panel when a recurring character, setting, or style differs from its reference.

| Task                                        | Call                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Build the hero, background, and cat anchors | `client.responses.create(model="muse-image-1.0", input="... character sheet ...")`                                |
| Render a panel from the references          | `client.responses.create(model="muse-image-1.0", previous_response_id=prev, input="...")`                         |
| Improve character and setting consistency   | generate each subject once, then chain later turns with `previous_response_id` and name the subject in the prompt |
| Compose the page                            | chain a turn from the last panel (`previous_response_id`) with a layout instruction                               |
| Letter the page                             | chain one more turn from the clean page, naming each line's speaker and asking for bubbles in empty space         |

**Production checklist:**

- Build the anchors first as clean reference plates, then chain the rest of the series from them.
- Anchor every recurring subject, not just the protagonist: any character or setting that appears in more than one frame gets its own reference so it stays consistent.
- Chain every later turn from the anchor with `previous_response_id` and name the subject in the prompt; the conversation carries it forward without re-uploading or re-describing it.
- Repeat the art-style words in every prompt.
- Compose the layout first, then letter it in a second turn, so each bubble lands on empty space with its tail on the named speaker.
- Keep bubble text short and uppercase so it renders legibly.

## Next steps {#next-steps}

- **Reference the image guide**: the [Image generation guide](https://dev.meta.ai/docs/image-generation) covers reference-image steering and the full parameter set.
- **See the Responses API**: the [Responses API guide](https://dev.meta.ai/docs/protocols/responses) covers `previous_response_id`, `input_image` parts, and the `output` item types.
- **Start with the basics**: the [Muse Image basics recipe](https://dev.meta.ai/docs/cookbook/image-generation-basics) covers generating and editing images from scratch.
