"""scripts/gguf_info.py: the stdlib GGUF header reader behind plug_in_model --check."""

from __future__ import annotations

import hashlib

import pytest

from scripts import gguf_info
from tests.gguf_helpers import glimmer_like, write_gguf


def test_reads_the_header_fields_types_and_vocabulary(tmp_path):
    g = gguf_info.read(glimmer_like(tmp_path / "m.gguf"))
    assert g.version == 3 and g.arch == "glimmer-test" and g.metadata["general.name"] == "Invented Test Model"
    assert g.file_type == "IQ1_S" and g.arch_value("block_count") == 4
    assert g.vocab_size == 5000 and isinstance(g.metadata["tokenizer.ggml.tokens"], gguf_info.Array)  # long: length only
    assert g.type_counts() == {"Q4_K": 1, "IQ1_S": 4, "F32": 1}
    assert g.params == 256 * 64 + 4 * 256 * 256 + 256
    assert g.bad_types() == {} and g.short_tensors() == 0 and not g.vision_tensors


def test_a_short_vocabulary_is_kept_as_a_list(tmp_path):
    g = gguf_info.read(glimmer_like(tmp_path / "m.gguf", vocab=10))
    assert g.vocab_size == 10 and g.metadata["tokenizer.ggml.tokens"][:2] == ["t0", "t1"]


def test_bits_per_weight_is_file_bytes_over_parameters_and_text_only_drops_vision(tmp_path):
    path = glimmer_like(tmp_path / "m.gguf", vision=True)
    g = gguf_info.read(path)
    size = path.stat().st_size
    assert g.bits_per_weight() == pytest.approx(size * 8 / g.params)
    vision_bytes = (256 * 32 + 256 * 16) * 2  # F16
    text_params = g.params - 256 * 32 - 256 * 16
    assert len(g.vision_tensors) == 2
    assert g.bits_per_weight(text_only=True) == pytest.approx((size - vision_bytes) * 8 / text_params)


def test_iq1_s_block_math():
    t = gguf_info.Tensor("w", (256, 4), 19, 0)
    assert t.type_name == "IQ1_S" and t.nbytes == 4 * 50 and t.nbytes * 8 / t.elements == 1.5625


def test_kv_cache_from_layers_heads_and_key_length(tmp_path):
    g = gguf_info.read(glimmer_like(tmp_path / "m.gguf"))
    # 4 layers x 2 KV heads x (32 + 32) key and value width (256 / 8 heads) x 2 bytes x ctx
    assert g.kv_cache_bytes(1024) == 1024 * 4 * 2 * 64 * 2
    g = gguf_info.read(glimmer_like(tmp_path / "h.gguf", **{
        "glimmer-test.attention.head_count_kv": [0, 2, 0, 2],  # a hybrid: two layers have no attention
        "glimmer-test.attention.key_length": 128, "glimmer-test.attention.value_length": 64,
    }))  # fmt: skip
    assert g.kv_cache_bytes(100) == 100 * 4 * (128 + 64) * 2
    g = gguf_info.read(write_gguf(tmp_path / "bare.gguf", {"general.architecture": "x"}, [("w", (32,), 0)]))
    assert g.kv_cache_bytes(100) is None


def test_unknown_and_removed_types_are_named(tmp_path):
    g = gguf_info.read(glimmer_like(tmp_path / "m.gguf", extra=[("odd.weight", (64,), 99), ("old.weight", (64,), 31)]))
    assert g.bad_types() == {99: "unknown (99)", 31: "Q4_0_4_4"}


@pytest.mark.parametrize(
    ("kw", "message"),
    [({"magic": b"GGML"}, "not a GGUF"), ({"version": 1}, "version 1"), ({"version": 3 << 24}, "big-endian")],
)
def test_wrong_files_are_refused_plainly(tmp_path, kw, message):
    path = write_gguf(tmp_path / "x.gguf", {"general.architecture": "x"}, [("w", (32,), 0)], **kw)
    with pytest.raises(gguf_info.GGUFError, match=message):
        gguf_info.read(path)


def test_a_cut_off_file_is_found(tmp_path):
    path = glimmer_like(tmp_path / "m.gguf")
    full = path.read_bytes()
    path.write_bytes(full[:20])
    with pytest.raises(gguf_info.GGUFError, match="ends inside its header"):
        gguf_info.read(path)
    path.write_bytes(full[:-100])  # the header is whole, the last tensor is not
    assert gguf_info.read(path).short_tensors() == 1


def test_sha256_matches_hashlib(tmp_path):
    path = glimmer_like(tmp_path / "m.gguf")
    assert gguf_info.sha256(path, chunk=1000) == hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize(
    ("printed", "build"),
    [("version: 0.7.0 (build 11669, commit 620d2225c)\nbuilt with clang", 11669), ("version: 4567 (abc1234)", 4567),
     ("something else", None)],
)
def test_llama_build_reads_both_version_formats(tmp_path, printed, build):
    fake = tmp_path / "llama-server"
    fake.write_text(f"#!/bin/sh\nprintf '%s\\n' '{printed}' >&2\n")
    fake.chmod(0o755)
    assert gguf_info.llama_build(fake) == build
    assert gguf_info.llama_build(tmp_path / "missing") is None and gguf_info.llama_build(None) is None
