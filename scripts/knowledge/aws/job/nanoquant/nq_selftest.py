"""Checks for the Glimmer adaptation (nq_glimmer.py).

cpu (no GPU, safe next to a training run):
  1. On a tiny random Glimmer (4 text layers: three sliding-window with RoPE, one full-attention NoPE; window 8 and
     24 tokens, so the sliding mask matters), chaining the decoder layers with nq_glimmer's per-layer arguments
     reproduces MuseGlimmerModel's own last hidden state exactly.
  2. NanoQuant's calculate_ranks, through the patched layer lookup, gives a rank to all 8 linears of all 52 layers of
     the real Glimmer config (built on the meta device, no weights), and the average bits per weight it implies.
  3. The chat rendering: AutoTokenizer and AutoProcessor render a training row and a probe prompt the same way, the
     markers train_glimmer.py checks are where it expects them, and how BOS is handled.
  4. A NanoQuantLinear round trip on CPU: convert a Linear with a made-up factorization, pack it into NanoQuant's
     state dict format, install it into a fresh Linear, and get bit-identical outputs.

    CUDA_VISIBLE_DEVICES= python nq_selftest.py cpu --base BASE_DIR --train-jsonl FILE --probes FILE
"""

import argparse
import argparse as _ap
import json
import os
import sys

import torch
import torch.nn as nn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nq_glimmer as nqg  # noqa: E402


def ok(name, **fields):
    print("SELFTEST " + json.dumps({"check": name, "ok": True, **fields}, default=str), flush=True)


def tiny_config():
    from transformers import MuseGlimmerConfig
    text = dict(hidden_size=64, intermediate_size=96, num_hidden_layers=4, num_attention_heads=4, num_key_value_heads=2,
                head_dim=16, vocab_size=512, sliding_window=8, max_position_embeddings=128,
                layer_types=["sliding_attention", "sliding_attention", "sliding_attention", "full_attention"],
                layer_rope_theta=[500000.0, 500000.0, 500000.0, 0], rope_parameters={"rope_theta": 500000.0, "rope_type": "default"},
                hidden_activation="silu", final_logit_softcapping=20.0, output_multiplier=0.2, qk_scale_factor=3.87,
                rms_norm_eps=1e-5, post_norm_eps=1e-8, bos_token_id=1, eos_token_id=2, pad_token_id=None, tie_word_embeddings=False)
    vision = dict(hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=2,
                  layer_types=["window_attention", "full_attention"], patch_size=14, merge_size=2, patch_temporal=2,
                  pos_emb_height=4, pos_emb_width=4, max_position_embeddings=64)
    return MuseGlimmerConfig(text_config=text, vision_config=vision, image_token_id=500, video_token_id=501,
                             out_hidden_size=64, projector_hidden_size=32)


@torch.no_grad()
def check_chain():
    from transformers import MuseGlimmerForConditionalGeneration
    torch.manual_seed(0)
    cfg = tiny_config()
    cfg._attn_implementation = "sdpa"
    cfg.text_config._attn_implementation = "sdpa"
    model = MuseGlimmerForConditionalGeneration(cfg).float().eval()
    # Random norm weights too, so a norm applied in the wrong place would show.
    for n, p in model.named_parameters():
        if "layernorm" in n or n.endswith("norm.weight"):
            p.normal_(0, 0.3)
    ids = torch.randint(3, 400, (2, 24))
    want = model.model(input_ids=ids).last_hidden_state
    lm = nqg.language_model(model)
    kw = nqg.layer_kwargs(lm, ids.shape[1], "cpu", batch=ids.shape[0])
    h = nqg.embed(lm, ids)
    for i, layer in enumerate(nqg.decoder_layers(model)):
        h = layer(h, **kw(i))
    got = lm.norm(h)
    diff = float((got - want).abs().max())
    if diff != 0.0:
        raise SystemExit(f"layer chain differs from the model's forward: max abs diff {diff}")
    # And the NoPE layer really gets no rotary embedding while the sliding ones do.
    kinds = [(cfg.text_config.layer_types[i], kw(i)["position_embeddings"] is not None) for i in range(4)]
    # With the wrong arguments (layer 0's for every layer), the chain must differ, or the test proves nothing.
    h2 = nqg.embed(lm, ids)
    for layer in nqg.decoder_layers(model):
        h2 = layer(h2, **kw(0))
    wrong = float((lm.norm(h2) - want).abs().max())
    if wrong == 0.0:
        raise SystemExit("the check can't tell per-layer arguments apart")
    ok("layer_chain_matches_forward", max_abs_diff=diff, layer_kinds=kinds, diff_if_layer0_args_everywhere=wrong)

    # Glimmer's logits: what glimmer_lce gives cut-cross-entropy must be the model's own logits function.
    tc = cfg.text_config
    hid = want[:1]
    logits = model.lm_head(hid) * tc.output_multiplier
    logits = torch.tanh(logits / tc.final_logit_softcapping) * tc.final_logit_softcapping
    full = model(input_ids=ids[:1]).logits
    d = float((logits - full).abs().max())
    scaled = tc.final_logit_softcapping * torch.tanh((hid @ (model.lm_head.weight * tc.output_multiplier).T) / tc.final_logit_softcapping)
    d2 = float((scaled - full).abs().max())
    if d > 1e-5 or d2 > 1e-5:
        raise SystemExit(f"softcap/multiplier form differs: {d} {d2}")
    ok("glimmer_logits_form", max_abs_diff_model_vs_formula=d, max_abs_diff_scaled_head=d2)


def check_ranks(base):
    from transformers import AutoConfig, MuseGlimmerForConditionalGeneration
    cfg = AutoConfig.from_pretrained(base)
    with torch.device("meta"):
        model = MuseGlimmerForConditionalGeneration(cfg)
    out = {}
    for bits in (0.8, 0.55):
        qc = {"bits": bits, "admm_type": "nanoquant"}
        ranks = nqg.nq_utils.calculate_ranks(model, nqg.LINEARS, qc)
        layers = nqg.decoder_layers(model)
        need = len(layers) * len(nqg.LINEARS)
        if len(ranks) != need:
            raise SystemExit(f"{len(ranks)} ranks for {need} linears")
        binary = scales = dense = 0
        shapes = {}
        for i, layer in enumerate(layers):
            for name in nqg.LINEARS:
                m = layer.get_submodule(name)
                r = ranks[f"{i}.{name}"]
                binary += r * (m.in_features + m.out_features)
                scales += 16 * (m.in_features + m.out_features)
                dense += m.in_features * m.out_features
                shapes[name] = {"in": m.in_features, "out": m.out_features, "rank": r}
        out[str(bits)] = {"bpw_with_scales": round((binary + scales) / dense, 5), "bpw_signs_only": round(binary / dense, 5),
                          "quantized_weights": dense, "per_linear": shapes}
    ok("ranks_real_config", layers=len(nqg.decoder_layers(model)), **out)


def check_template(base, train_jsonl, probes):
    from transformers import AutoProcessor
    tok = nqg.load_tokenizer(base)
    proc = AutoProcessor.from_pretrained(base)
    with open(train_jsonl) as f:
        row = json.loads(f.readline())
    with open(probes) as f:
        probe = json.loads(f.readline())
    t_tok = nqg.render(tok, row["messages"], False)
    t_proc = proc.apply_chat_template(row["messages"], tokenize=False, add_generation_prompt=False, reasoning_strength=nqg.REASONING)
    bos = tok.bos_token or ""
    t_proc = t_proc.removeprefix(bos) if bos else t_proc
    if t_tok != t_proc:
        raise SystemExit("tokenizer and processor render the training row differently")
    for m in row["messages"]:
        marker = {"user": "<|start|>user<|message|>", "assistant": "<|start|>assistant to=user<|message|>"}.get(m["role"])
        if marker and marker + m["content"] not in t_tok:
            raise SystemExit("marker missing for " + m["role"])
    p = nqg.probe_prompt(tok, probe["question"])
    ids = tok(t_tok, add_special_tokens=True).input_ids
    ok("chat_template", train_render_head=t_tok[:160], probe_prompt_tail=p[-120:], tokenizer_adds_bos=ids[0] == tok.bos_token_id,
       bos=bos, pad=tok.pad_token, tokens_in_row=len(ids))


@torch.no_grad()
def check_roundtrip():
    from nanoquant.modules.linear import NanoQuantLinear
    torch.manual_seed(0)
    a, b, r = 96, 64, 32
    holder = nn.Module()
    holder.proj = nn.Linear(a, b, bias=False).to(torch.bfloat16)
    fact = _ap.Namespace(A=torch.randn(r, b), B=torch.randn(r, a), A_latent=torch.randn(r, b), B_latent=torch.randn(r, a),
                         scale_pre=torch.rand(1, a) + 0.5, scale_post=torch.rand(1, b) * 0.1)
    holder.proj.__class__ = NanoQuantLinear
    holder.proj.__quant_convert__(do_train=False, rank=r, factor_results=fact)
    x = torch.randn(5, a, dtype=torch.bfloat16)
    y1 = holder.proj(x)
    sd = nqg.compressed_state(holder, device="cpu")
    fresh = nn.Module()
    fresh.proj = nn.Linear(a, b, bias=False).to(torch.bfloat16)
    nqg.install_quantized(fresh, sd, device="cpu")
    y2 = fresh.proj(x)
    if not torch.equal(y1, y2):
        raise SystemExit("NanoQuantLinear round trip changed the output")
    bits = nqg.module_bits(fresh.proj)
    ok("nanoquantlinear_roundtrip", keys=sorted(sd), packed_dtype=str(sd["proj.V_packed"].dtype), bits=bits)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["cpu"])
    ap.add_argument("--base", required=True)
    ap.add_argument("--train-jsonl", required=True)
    ap.add_argument("--probes", required=True)
    a = ap.parse_args()
    torch.set_num_threads(min(8, os.cpu_count() or 8))
    check_chain()
    check_ranks(a.base)
    check_template(a.base, a.train_jsonl, a.probes)
    check_roundtrip()
    print("SELFTEST ALL_OK", flush=True)


if __name__ == "__main__":
    main()
