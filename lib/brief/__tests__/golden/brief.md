# Bird Count

Count the birds in a photo

**For:** Birders

**Verdict:** Can be made

## Inspiration

A photo of a feeder.

- **Reference 1** (image): Three sparrows on a feeder.

**Takes from it:**

- Counting birds from a photo

**Leaves out:**

- The exact pixels of the person's photo

**Test inputs:**

- Reference 1, the person's own image: The person's feeder photo

The test feeds these to the product. Showing them as the input or inside the result is expected.

## How it works

1. Upload a photo
2. See the count with boxes

## Meta models

| Need | Model | Why |
| --- | --- | --- |
| Find birds | `sam-3.1` | It boxes objects |

## Inputs

- **image**: A photo

## Outputs

- **overlay**: Boxes

## Actions

- `count_birds`: Takes a photo, returns a count.

## Limits

- Counts are estimates.

## Cost

About $0.01 per run (estimate). One SAM call.

Complexity: simple.
