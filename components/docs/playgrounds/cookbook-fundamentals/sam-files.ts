/**
 * The search-and-replace-edits recipe's sample project: files from facebookresearch/segment-anything (Apache 2.0) at
 * the commit the recipe pins (dca509fe), so the recipe's payloads and line numbers match what the demo edits:
 * build_sam.py whole, __init__.py whole, and the top of predictor.py. The six tasks are the recipe's prompts.
 */

const HEADER = `# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.

# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.
`;

const BUILD_SAM = `${HEADER}
import torch

from functools import partial

from .modeling import ImageEncoderViT, MaskDecoder, PromptEncoder, Sam, TwoWayTransformer


def build_sam_vit_h(checkpoint=None):
    return _build_sam(
        encoder_embed_dim=1280,
        encoder_depth=32,
        encoder_num_heads=16,
        encoder_global_attn_indexes=[7, 15, 23, 31],
        checkpoint=checkpoint,
    )


build_sam = build_sam_vit_h


def build_sam_vit_l(checkpoint=None):
    return _build_sam(
        encoder_embed_dim=1024,
        encoder_depth=24,
        encoder_num_heads=16,
        encoder_global_attn_indexes=[5, 11, 17, 23],
        checkpoint=checkpoint,
    )


def build_sam_vit_b(checkpoint=None):
    return _build_sam(
        encoder_embed_dim=768,
        encoder_depth=12,
        encoder_num_heads=12,
        encoder_global_attn_indexes=[2, 5, 8, 11],
        checkpoint=checkpoint,
    )


sam_model_registry = {
    "default": build_sam_vit_h,
    "vit_h": build_sam_vit_h,
    "vit_l": build_sam_vit_l,
    "vit_b": build_sam_vit_b,
}


def _build_sam(
    encoder_embed_dim,
    encoder_depth,
    encoder_num_heads,
    encoder_global_attn_indexes,
    checkpoint=None,
):
    prompt_embed_dim = 256
    image_size = 1024
    vit_patch_size = 16
    image_embedding_size = image_size // vit_patch_size
    sam = Sam(
        image_encoder=ImageEncoderViT(
            depth=encoder_depth,
            embed_dim=encoder_embed_dim,
            img_size=image_size,
            mlp_ratio=4,
            norm_layer=partial(torch.nn.LayerNorm, eps=1e-6),
            num_heads=encoder_num_heads,
            patch_size=vit_patch_size,
            qkv_bias=True,
            use_rel_pos=True,
            global_attn_indexes=encoder_global_attn_indexes,
            window_size=14,
            out_chans=prompt_embed_dim,
        ),
        prompt_encoder=PromptEncoder(
            embed_dim=prompt_embed_dim,
            image_embedding_size=(image_embedding_size, image_embedding_size),
            input_image_size=(image_size, image_size),
            mask_in_chans=16,
        ),
        mask_decoder=MaskDecoder(
            num_multimask_outputs=3,
            transformer=TwoWayTransformer(
                depth=2,
                embedding_dim=prompt_embed_dim,
                mlp_dim=2048,
                num_heads=8,
            ),
            transformer_dim=prompt_embed_dim,
            iou_head_depth=3,
            iou_head_hidden_dim=256,
        ),
        pixel_mean=[123.675, 116.28, 103.53],
        pixel_std=[58.395, 57.12, 57.375],
    )
    sam.eval()
    if checkpoint is not None:
        with open(checkpoint, "rb") as f:
            state_dict = torch.load(f)
        sam.load_state_dict(state_dict)
    return sam
`;

const INIT = `${HEADER}
from .build_sam import (
    build_sam,
    build_sam_vit_h,
    build_sam_vit_l,
    build_sam_vit_b,
    sam_model_registry,
)
from .predictor import SamPredictor
from .automatic_mask_generator import SamAutomaticMaskGenerator
`;

const PREDICTOR = `${HEADER}
import numpy as np
import torch

from segment_anything.modeling import Sam

from typing import Optional, Tuple

from .utils.transforms import ResizeLongestSide


class SamPredictor:
    def __init__(
        self,
        sam_model: Sam,
    ) -> None:
        """
        Uses SAM to calculate the image embedding for an image, and then
        allow repeated, efficient mask prediction given prompts.

        Arguments:
          sam_model (Sam): The model to use for mask prediction.
        """
        super().__init__()
        self.model = sam_model
        self.transform = ResizeLongestSide(sam_model.image_encoder.img_size)
        self.reset_image()
`;

export const SAM_FILES: Record<string, string> = {
  "segment_anything/build_sam.py": BUILD_SAM,
  "segment_anything/__init__.py": INIT,
  "segment_anything/predictor.py": PREDICTOR,
};

export interface EditTask {
  label: string;
  prompt: string;
}

/** The recipe's six prompts, as typed into OpenCode. */
export const EDIT_TASKS: EditTask[] = [
  {
    label: "1. Single-line change",
    prompt:
      "In segment_anything/build_sam.py, change the SAM input image size in _build_sam from 1024 to 512. Make a precise in-place edit; do not rewrite the file.",
  },
  {
    label: "2. Multi-line rewrite",
    prompt:
      'In segment_anything/build_sam.py, make checkpoint loading CPU-safe: pass map_location="cpu" to torch.load inside _build_sam. Edit the existing block in place.',
  },
  {
    label: "3. Several edits, one file",
    prompt:
      "In segment_anything/build_sam.py, add a one-line docstring to each of the three public build functions (build_sam_vit_h, build_sam_vit_l, build_sam_vit_b) describing the model size.",
  },
  {
    label: "4. New file plus an edit",
    prompt:
      'Add a version module: create segment_anything/version.py defining __version__ = "1.0" with the repo license header, then export __version__ from segment_anything/__init__.py.',
  },
  {
    label: "5. Disambiguate repeated code",
    prompt: "In segment_anything/build_sam.py, change ONLY build_sam_vit_l encoder_num_heads from 16 to 8, not the identical value in build_sam_vit_h.",
  },
  {
    label: "6. Insert at the top",
    prompt:
      "At the top of segment_anything/predictor.py, above the imports, add a one-line module comment: # SamPredictor: image embedding and prompt-based mask prediction.",
  },
];

/** Hand-made edits that break the exactly-once rule, applied in the page with no API call. */
export const BROKEN_EDITS: Array<{ label: string; why: string; call: { tool: "edit" | "write"; filePath: string; oldString?: string; newString?: string; replaceAll?: boolean; content?: string } }> = [
  {
    label: "Whitespace mismatch",
    why: "Eight-space indentation where the file has four: zero matches, so the edit is rejected.",
    call: { tool: "edit", filePath: "segment_anything/build_sam.py", oldString: "        image_size = 1024", newString: "        image_size = 512" },
  },
  {
    label: "Ambiguous match",
    why: "encoder_num_heads=16 is in build_sam_vit_h and build_sam_vit_l: two matches, rejected.",
    call: { tool: "edit", filePath: "segment_anything/build_sam.py", oldString: "encoder_num_heads=16,", newString: "encoder_num_heads=8," },
  },
  {
    label: "replaceAll on purpose",
    why: "The same text with replaceAll: true changes every occurrence, here both functions.",
    call: { tool: "edit", filePath: "segment_anything/build_sam.py", oldString: "encoder_num_heads=16,", newString: "encoder_num_heads=8,", replaceAll: true },
  },
  {
    label: "write over an existing file",
    why: "write replaces the whole file: it applies, but it discards what was there. Reserve it for new files.",
    call: { tool: "write", filePath: "segment_anything/__init__.py", content: "from .build_sam import build_sam\n" },
  },
];
