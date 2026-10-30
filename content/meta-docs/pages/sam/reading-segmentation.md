# Read Segment Anything Model segmentation output {#read-segment-anything-model-segmentation-output}

Segmentation output arrives as special-token text in one `output_text` lane: one line per frame, with boxes and masks inline. Read each line into geometry you can render or measure.

## Read one line per frame {#read-one-line-per-frame}

The stream carries a single `output_text` lane. Each frame emits one `response.output_text.delta` event holding one line. The stream terminates on `response.completed`.

Send the request with `stream` set to `true` (see [segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting#stream)). Accumulate the delta payloads and treat `response.completed` as the end of output.

Zero matches is a valid outcome. The stream completes with an empty `output_text` and no `response.output_text.delta` events. Branch on the empty lane rather than treating it as an error.

## Track objects across frames {#object-identity}

Segment Anything Model 3.1 (SAM 3.1) preserves object identity across frames. The leading integer on each record (see [line structure](https://dev.meta.ai/docs/sam/reading-segmentation#structure)) is a stable **object id** within a response: id `1` on one frame names the same object as id `1` on a later frame. The ids on a line are **not** a dense, `0`-based sequence — they are the ids of whichever objects are present on that frame, so a line can carry a sparse set like `0, 2` (for example when an object leaves the frame). Key your masks by object id, never by position within the line.

Follow an object by holding its object id: read its box and mask across frames by id, with no client-side box matching. This holds while the object stays in frame — don't rely on the id across an object's entry, exit, or full occlusion, or over very long clips.

With [box and point prompts](https://dev.meta.ai/docs/sam/segmenting#object-prompts), you choose the ids: the response reports each prompted object under the id your request gave it.

To hide or toggle objects in a rendered overlay, see [client libraries](https://dev.meta.ai/docs/sam/client-libraries).

## Line structure {#structure}

The format nests top-down:

- The `output_text` lane holds one line per frame.
- A line is a frame marker `<Nf>` followed by comma-separated records.
- A record is an object id, then one box token, then one mask token.
- Every record pairs exactly one box with exactly one mask, box first.
- Box and mask tokens carry a confidence field, `c`, only when the request sets [`include_confidence`](https://dev.meta.ai/docs/sam/segmenting#confidence).

The line shape:

```text
<Nf>id<|box;x1=..;y1=..;x2=..;y2=..;w=<frameW>;h=<frameH>[;c=<conf>]|><|mask;x=0;y=0[;c=<conf>];data=<H>,<W>,<enc>payload|>,id<|box;...|><|mask;...|>
```

As a grammar:

```text
line      ::= FRAME record ( "," record )*
record    ::= OBJECT_ID box mask
box       ::= "<|box;x1=" INT ";y1=" INT ";x2=" INT ";y2=" INT ";w=" INT ";h=" INT [ CONF ] "|>"
mask      ::= "<|mask;x=0;y=0" [ CONF ] ";data=" H "," W "," ENC PAYLOAD "|>"
CONF      ::= ";c=" DECIMAL    ; confidence, 0 to 1; only with include_confidence
FRAME     ::= "<" INT "f>"      ; frame index, zero-based; may skip frames; not always ascending
OBJECT_ID ::= INT              ; stable per-object id; not dense or 0-based
INT       ::= [0-9]+
DECIMAL   ::= [0-9]+ ( "." [0-9]+ )?
H         ::= INT              ; mask raster height (rows), in pixels
W         ::= INT              ; mask raster width (columns), in pixels
ENC       ::= "~"              ; lossless (default)
            | "!"              ; one_bit
PAYLOAD   ::= <base85 bytes>   ; base85-encoded, not base64; may contain "~" or "!"
```

Frame and object-id semantics:

- **Frame marker `<Nf>`**: `N` is the frame index, zero-indexed but **not necessarily contiguous or ascending**. A frame on which no object is visible emits no line, so indices can skip — a clip can run `<0f>`, `<2f>`, … with frame 1 omitted. Read the explicit `<Nf>` value; never assume the Nth line is source frame N. A single image is emitted as frame `<0f>`.
- **Frame order**: concept prompts return frames in ascending order. Box and point prompts follow the request's [tracking direction](https://dev.meta.ai/docs/sam/segmenting#tracking-direction): `forward` and `backward` both start on the earliest prompt frame, and the default `both` returns the forward frames first, then the backward ones. With `both`, prompts on frames 30 and 120 of a 200-frame clip return frames 30 through 199, then 29 down to 0.
- **One line per emitted frame**: each line is one `response.output_text.delta` and carries one frame's records. Frames with no visible objects produce no line at all.
- **Object id**: a bare integer, comma-separated within the line, and a stable per-object id across frames (see [track objects across frames](https://dev.meta.ai/docs/sam/reading-segmentation#object-identity)). The ids on a line are the objects present on that frame — **not** a dense `0`-based sequence — so a line can carry a sparse set like `0, 2`. There is no `object=` key and no string id.

## Video output grammar {#video-grammar}

A video emits one line per frame. Frame 0 of a six-frame clip, prompt `button`, 320×334 source, two objects:

```text
<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>,1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>
```

Mapped to the structure:

- **`<0f>`**: frame marker for frame index 0.
- **`0`** before the first box: the object id of the first record.
- **`<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>`**: the box for that record. Corners are source pixels; `w=320;h=334` is the source frame size.
- **`<|mask;x=0;y=0;data=27,60,~...|>`**: the mask for that record. `27,60` is the mask raster as **height,width** (27 rows × 60 columns); `~` is the lossless default.
- **`,1`**: the record separator, then the object id `1` opening the second record.

## Image output grammar {#image-grammar}

A single image is emitted as frame `<0f>`: one line, one `response.output_text.delta`. Image output uses the same grammar as video. Only the line count differs: one line for an image, N lines for a video.

Image, prompt `button`, three matches, 537×561 source (mask payloads elided):

```text
<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~...|>,1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,81,~...|>,2<|box;x1=516;y1=117;x2=536;y2=150;w=537;h=561|><|mask;x=0;y=0;data=34,21,~...|>
```

The object ids here are `0`, `1`, `2` — dense only because all three matched; a filtered or absent object would leave a gap (e.g. `0, 2`). `w=537;h=561` is the source image size, repeated on every record.

## Boxes and masks {#record-layout}

### Box {#box}

```text
<|box;x1=<int>;y1=<int>;x2=<int>;y2=<int>;w=<frameW>;h=<frameH>[;c=<conf>]|>
```

| Field      | Meaning                                                                                                    | Units              |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------------------ |
| `x1`, `y1` | Top-left corner of the box                                                                                 | Source pixels      |
| `x2`, `y2` | Bottom-right corner of the box                                                                             | Source pixels      |
| `w`, `h`   | Source frame or image dimensions, repeated on every record                                                 | Source pixels      |
| `c`        | The model's confidence for the record. Present only when the request sets `include_confidence` to `"true"` | Number from 0 to 1 |

Scale by the ratio between source pixels and display pixels when you draw overlays.

### Mask {#mask}

```text
<|mask;x=0;y=0[;c=<conf>];data=<H>,<W>,<enc>payload|>
```

| Field     | Meaning                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x`, `y`  | Mask origin, always the literal `0`.                                                                                                                                                                                                                      |
| `c`       | The model's confidence for the record, the same value as on the record's box. Present only when the request sets `include_confidence` to `"true"`.                                                                                                        |
| `data`    | An explicit key. Its value is `<H>,<W>,<enc>payload`.                                                                                                                                                                                                     |
| `H`, `W`  | The mask's own raster dimensions as **height then width** (rows, then columns), comma-separated integers, smaller than the frame. Height-first: a `data=37,51` mask is 37 rows × 51 columns, not 37 wide.                                                 |
| `<enc>`   | The encoding marker: the first character after `H,W,`. `~` is the default lossless encoding; `!` is one\_bit.                                                                                                                                             |
| `payload` | The encoded bytes, in base85 (not base64) — a base64 charset or regex won't match, so decode with a base85 alphabet. The payload can itself contain `!`, `~`, or other printable characters, so read only the first character after `H,W,` as the marker. |

Set the encoding with `metadata.mask_encoding` on the request (see [segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting#mask-encoding)).

### Confidence {#confidence}

With [`include_confidence`](https://dev.meta.ai/docs/sam/segmenting#confidence) set to `"true"`, every box and mask carries `c`. On a box it follows `h`; on a mask it sits between `y` and `data`:

```text
<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.9609375|><|mask;x=0;y=0;c=0.9609375;data=226,236,!...|>
```

`c` belongs to one frame's record, so the same object can carry a different value on each frame. Parse fields by key rather than by position, so a token reads the same with or without `c`.

## Decode a mask {#decode-masks}

Pass the mask record to `decodeMaskToRaster` for a binary raster:

**TypeScript**

```typescript
const raster = decodeMaskToRaster(record.mask);
// Row-major Uint8Array of 0 or 1, length H * W (rows × columns).
```

`decodeMaskToRaster(record.mask)` returns a row-major `Uint8Array` of `0` and `1`, with exactly `H * W` entries (height × width). Request `one_bit` masks with [`metadata.mask_encoding`](https://dev.meta.ai/docs/sam/segmenting#mask-encoding) for the smallest payloads. A mask record always carries a complete payload, so the raster is never partial. To convert a mask to COCO RLE or an SVG path instead, and for the full call shape, see [client libraries](https://dev.meta.ai/docs/sam/client-libraries#decode-mask).

## Next steps {#next-steps}

With the wire grammar in hand, send it and render it:

- Shape the call with [Segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting).
- Parse, decode, and draw with [client libraries](https://dev.meta.ai/docs/sam/client-libraries).
- Place the stream in the full event flow with the [Responses API](https://dev.meta.ai/docs/protocols/responses).
