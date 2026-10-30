# Build a computer-use agent {#build-a-computer-use-agent}

Give [Muse Wonder](https://dev.meta.ai/docs/models#muse-wonder), Meta's most capable model, a screen and let it drive. A computer-use agent (CUA) looks at a screenshot, decides where to click and what to type, and works a browser or desktop toward a goal one step at a time. This [observe-act loop](https://dev.meta.ai/docs/computer-use#how-it-works) runs through the native [computer tool](https://dev.meta.ai/docs/computer-use#enable-tool): add it to a [Responses API](https://dev.meta.ai/docs/protocols/responses) request — its only supported endpoint — and the model returns structured mouse and keyboard actions that your application executes before handing back the next screenshot.

The computer tool defines the action **protocol**, not an environment. There's no server-side virtual machine: Meta doesn't run a browser or desktop for you, and the model never touches a screen. The tool is an abstraction that standardizes the observe-act round-trip into a fixed vocabulary of actions and screenshots the model was trained to recognize. You supply the rest: the environment, the driver that executes each action, screenshot capture, and safety.

## How the observe-act loop works {#how-it-works}

The loop has five steps:

1. **Send** the task and an initial screenshot to the model with the computer tool enabled.
2. **Receive** a `computer_call` output item carrying one or more actions.
3. **Execute** the actions in your environment.
4. **Capture** a fresh screenshot and return it as a `computer_call_output`.
5. **Repeat** until the model stops issuing `computer_call` items or the task is infeasible.

The model decides what to do next; your application owns everything else: the environment, action execution, screenshot capture, validation, logging, and recovery. The model sees a small action vocabulary and the current screen. It never needs to know your automation library or VM internals.

## Enable the computer tool {#enable-tool}

Add a single tool entry to the request. The computer tool takes only a `type`:

**JSON**

```json
{
  "tools": [{"type": "computer"}]
}
```

There are no display-size or environment fields to configure. The model reasons directly about the screenshot you send, so the same tool definition works for a browser viewport, a full desktop, or a sandboxed VM.

Each turn the model returns a single `computer_call` carrying its batched actions; execute them, then send one screenshot back before the next turn.

## Provide a driver {#driver}

The API returns actions; you supply a **driver** that turns them into real input and produces screenshots. A driver has four jobs:

- **Capture screenshots**: produce a PNG or JPEG of the current screen after each step.
- **Execute actions**: map each action (`click`, `type`, `scroll`, …) to a real mouse or keyboard event at the given pixel coordinates.
- **Handle safety checks**: surface and acknowledge the checks the API attaches to an action before you run it.
- **Decide when to stop**: cap the number of steps, and treat the model's final message as terminal.

### Choosing a driver {#choosing-a-driver}

The model is driver-agnostic, so match the tool to your environment. Common choices:

- **Browser tasks**: a browser-automation library such as [Playwright](https://playwright.dev/) or [Puppeteer](https://pptr.dev/) maps cleanly to click, type, scroll, and screenshot.
- **Desktop tasks**: an OS input library such as [pyautogui](https://pypi.org/project/PyAutoGUI/) drives a real or virtual desktop.
- **Sandboxed environments**: a disposable VM or container keeps the agent off your machine. The [computer-use cookbook recipe](https://dev.meta.ai/docs/cookbook/computer-use) drives a throwaway Linux desktop this way and is a complete worked example of a driver.

These are common choices; any library that can execute an action and return a screenshot works.

## Read and execute actions {#actions}

A `computer_call` carries a batch of actions to run in order before the next screenshot:

**JSON**

```json
{
  "type": "computer_call",
  "id": "cc_abc123",
  "call_id": "call_abc123",
  "actions": [
    {"type": "click", "button": "left", "x": 412, "y": 315},
    {"type": "type", "text": "quarterly revenue"},
    {"type": "keypress", "keys": ["Enter"]}
  ],
  "pending_safety_checks": [],
  "status": "completed"
}
```

The action vocabulary:

| `type`         | Fields                                                           | Meaning                                               |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| `click`        | `button` (`left`, `right`, `wheel`, `back`, `forward`), `x`, `y` | Single mouse click.                                   |
| `double_click` | `x`, `y`                                                         | Double click.                                         |
| `drag`         | `path` (array of `{x, y}`)                                       | Press, move through the path, and release.            |
| `keypress`     | `keys` (array of strings)                                        | Press a key or key combination.                       |
| `move`         | `x`, `y`                                                         | Move the cursor.                                      |
| `scroll`       | `x`, `y`, `scroll_x`, `scroll_y`                                 | Scroll at a point by the given deltas.                |
| `type`         | `text`                                                           | Type literal text.                                    |
| `screenshot`   | —                                                                | Capture a fresh screenshot with no other action.      |
| `wait`         | —                                                                | Wait for the UI to settle before the next screenshot. |

Coordinates are **pixel coordinates** in the space of the screenshot you last sent: `(0, 0)` is the top-left, and the maximum is the width and height of that image. Map every action against the exact image the model saw, and keep the screenshot size stable across a trajectory. For browser use, screenshot the viewport that produced the coordinates, not the full page.

Run the batch in order and capture one screenshot after it finishes. Stop the batch early if an action fails, the page navigates unexpectedly, or a modal changes the screen in a way that invalidates later actions. Then return a screenshot and let the model choose the next step.

## Return a screenshot {#screenshots}

Send the post-action screenshot back as a `computer_call_output`, echoing the `call_id`:

**JSON**

```json
{
  "type": "computer_call_output",
  "call_id": "call_abc123",
  "acknowledged_safety_checks": [],
  "output": {
    "type": "computer_screenshot",
    "image_url": "data:image/png;base64,<...>"
  }
}
```

`image_url` is a base64 PNG or JPEG data URL. The declared MIME type must match the image bytes, and the decoded image must be 25 MiB or smaller; otherwise the request returns `HTTP 400`. A coordinate action needs a screenshot to resolve against, so return one every turn. A `screenshot`-only or `wait`-only call is the exception: it needs no earlier image.

## Handle safety checks {#safety}

When an action needs explicit developer sign-off, the API attaches `pending_safety_checks` to the `computer_call`. Each check is `{id, code, message}`. Review the check, and if you accept the action, echo the checks in `acknowledged_safety_checks` on the matching `computer_call_output`:

**JSON**

```json
{
  "type": "computer_call_output",
  "call_id": "call_def456",
  "acknowledged_safety_checks": [
    {"id": "csc_123", "code": "malicious_instructions", "message": "Potentially unsafe action detected."}
  ],
  "output": {"type": "computer_screenshot", "image_url": "data:image/png;base64,<...>"}
}
```

Acknowledgement asserts that you reviewed the action and accept it. Treat a safety check as a decision point in your harness, not a field to auto-fill.

## Run the loop {#loop}

Drive the loop over the Responses API. Each turn, the model returns a `computer_call`; you execute it, then send back a `computer_call_output` with a fresh screenshot. Chain turns with `previous_response_id` so the server keeps conversation state:

**Python**

```python
import base64
import os

from openai import OpenAI

client = OpenAI(
    base_url="https://api.meta.ai/v1",
    api_key=os.environ["MODEL_API_KEY"],
)


def screenshot_data_url(png_bytes: bytes) -> str:
    # This example captures PNG; use "image/jpeg" if your driver returns JPEG.
    b64 = base64.b64encode(png_bytes).decode()
    return f"data:image/png;base64,{b64}"


def run(task: str, driver, system_prompt: str, max_steps: int = 50) -> str:
    response = client.responses.create(
        model="muse-wonder-1.0",
        instructions=system_prompt,
        tools=[{"type": "computer"}],
        input=[{
            "role": "user",
            "content": [
                {"type": "input_text", "text": task},
                {"type": "input_image", "image_url": screenshot_data_url(driver.screenshot())},
            ],
        }],
    )

    for _ in range(max_steps):
        calls = [item for item in response.output if item.type == "computer_call"]
        if not calls:
            return response.output_text  # the model finished and gave its answer

        call = calls[0]

        # Review each safety check before acting. Approve by your own policy or a
        # human in the loop; acknowledging asserts you accept the action.
        approved = [c for c in call.pending_safety_checks if driver.approve_safety_check(c)]
        if len(approved) != len(call.pending_safety_checks):
            return "stopped: safety check declined"

        driver.execute(call.actions)  # run the batch in order
        png = driver.screenshot()

        response = client.responses.create(
            model="muse-wonder-1.0",
            previous_response_id=response.id,
            tools=[{"type": "computer"}],
            input=[{
                "type": "computer_call_output",
                "call_id": call.call_id,
                "acknowledged_safety_checks": [c.model_dump() for c in approved],
                "output": {
                    "type": "computer_screenshot",
                    "image_url": screenshot_data_url(png),
                },
            }],
        )

    return "stopped: step budget reached"
```

The loop ends when a response contains no `computer_call` item: the model has returned a normal assistant message with its answer or an explanation of why the task can't be done.

The loop runs on `muse-wonder-1.0`. [Muse Spark](https://dev.meta.ai/docs/models#muse-spark) runs the same loop at lower cost: set both `model` values to `muse-spark-1.3`. That saving adds up on long runs, where screenshots dominate the token count.

## Manage conversation state {#state}

You have two ways to carry the trajectory:

- **Server-managed state**: pass `previous_response_id` with `store: true` (the default) and send only the new `computer_call_output` each turn (as in the loop above). The server holds the history. This is the simplest path.
- **Stateless replay**: set `store: false` and replay the full history (every `computer_call` and `computer_call_output` pair) on each request. Copy each `meta_safety_replay_receipt` unchanged from `response.output` into the matching input item, and still acknowledge safety checks on the new turn. Direct stateless replay holds up to 29 call/output pairs.

Long runs grow fast, because screenshots dominate the token count. Where it's enabled for your account, set `truncation: "auto"` to have the API manage screenshot history for computer requests: it keeps recent screenshots and trims older ones to stay inside the 1,048,576-token context window. `truncation` defaults to `"disabled"`; if `"auto"` isn't enabled for your account the request returns `HTTP 400`, so fall back to stateless replay or `previous_response_id` chaining. Reach for stateless replay when reproducibility and local control matter; reach for server-managed state with `truncation: "auto"` when you want the least client-side bookkeeping.

## Handle done and incomplete {#terminal}

The model ends a session by returning an assistant message instead of a `computer_call`. Your harness captures the final screenshot, saves the trajectory, and treats the message as terminal.

- **Done**: the model should finish only when the goal is visibly complete on screen or the required answer has been produced. Don't accept a "done" that follows an action triggering async work unless the resulting UI confirms it.
- **Infeasible**: let the model give up cleanly when the task can't be completed from the available UI: a missing account or permission, required credentials the harness can't supply, a broken or blocked UI, or an underspecified goal. This prevents loops where the agent keeps clicking after it's blocked.

If generation reaches `max_output_tokens`, the response returns `HTTP 200` with `status: "incomplete"` and `incomplete_details.reason: "max_output_tokens"`; a streamed run terminates with `response.incomplete`. Raise the budget and continue from the same state.

## Set a strict system prompt {#system-prompt}

The system prompt is where you lock in the rules for batching, waiting, finishing, and declaring a task infeasible. Pass it as `instructions` on the Responses API:

**System prompt**

```text
You are a computer-use agent operating a browser or desktop environment. You receive
screenshots and choose the next action or actions.

Coordinates are pixels in the screenshot you were last shown: (0, 0) is the top-left. Click
the center of the target element.

Return a short batch of actions only when they do not depend on intermediate visual
feedback, such as click, type, and keypress. Do not batch across page loads, searches,
modal transitions, or any step where the next action depends on a new screenshot. Use wait
when the page is loading or an action needs time to take effect.

Finish by replying with a normal message: the answer when the goal is visibly complete, or a
short explanation when the task is infeasible because of missing permissions, credentials,
unavailable UI, ambiguity, or repeated lack of progress.

Do not guess hidden UI state and do not claim completion unless the screenshot supports it.
If a target is not visible, scroll or request a new screenshot before clicking.
```

## Code execution as an alternative {#code-execution}

The computer tool returns one structured action at a time, which keeps every step visible and easy to gate. When a task is scriptable (a fixed sequence of browser steps, a form fill, a bulk operation), you can instead let the model write the automation code and run it in your own sandbox.

In this pattern you expose a developer-defined [function tool](https://dev.meta.ai/docs/tool-calling) such as `run_python` or `run_browser_script`, and the model emits a snippet that calls a library like Playwright or pyautogui. One call can combine actions, loops, and conditional logic:

**Python (model-generated script)**

```python
# The model emits code like this; your harness runs it in a sandbox.
page.goto("https://example.com/reports")
page.get_by_role("link", name="Q3 revenue").click()
page.get_by_role("button", name="Export CSV").click()
```

Both approaches have their merits:

- **Computer tool**: best when the model must react to each screen and you want per-action safety checks.
- **Code execution**: best when the steps are known ahead of time and you want fewer round trips.

Both run entirely in your environment; the model never executes anything itself.

## Next steps {#next-steps}

Now that the loop is running, tighten the pieces that make it robust:

- Work through the [computer-use cookbook recipe](https://dev.meta.ai/docs/cookbook/computer-use) for a complete driver you can adapt into your own harness.
- Combine the computer tool with your own helpers through [tool calling](https://dev.meta.ai/docs/tool-calling).
- Carry the model's reasoning across long sessions with the [Responses API](https://dev.meta.ai/docs/protocols/responses) and [reasoning replay](https://dev.meta.ai/docs/reasoning).
- Feed high-quality screenshots by matching your capture to the model's [image understanding](https://dev.meta.ai/docs/image-understanding).
