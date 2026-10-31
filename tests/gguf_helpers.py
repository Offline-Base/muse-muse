"""Tiny GGUF v3 files for tests: a header, a tensor table and zero bytes for the data."""

from __future__ import annotations

import struct
from pathlib import Path

from scripts.gguf_info import TYPES

ALIGN = 32


def _str(s: str) -> bytes:
    data = s.encode()
    return struct.pack("<Q", len(data)) + data


def _value(v) -> bytes:
    if isinstance(v, bool):
        return struct.pack("<I?", 7, v)
    if isinstance(v, int):
        return struct.pack("<II", 4, v)
    if isinstance(v, float):
        return struct.pack("<If", 6, v)
    if isinstance(v, str):
        return struct.pack("<I", 8) + _str(v)
    if all(isinstance(x, str) for x in v):
        return struct.pack("<IIQ", 9, 8, len(v)) + b"".join(_str(x) for x in v)
    return struct.pack("<IIQ", 9, 5, len(v)) + b"".join(struct.pack("<i", x) for x in v)


def _pad(n: int) -> int:
    return -(-n // ALIGN) * ALIGN


def write_gguf(path: Path, metadata: dict, tensors: list[tuple[str, tuple[int, ...], int]], *, cut: int = 0,
               version: int = 3, magic: bytes = b"GGUF") -> Path:
    """Write `tensors` as (name, shape, type id). A type this repo does not know gets 2 bytes per
    element. `cut` leaves that many bytes off the end, like an unfinished copy."""
    table, offset, sizes = b"", 0, []
    for name, shape, type_id in tensors:
        elements = 1
        for d in shape:
            elements *= d
        _n, block, size = TYPES.get(type_id, ("?", 1, 2))
        nbytes = elements // block * size
        table += _str(name) + struct.pack("<I", len(shape)) + b"".join(struct.pack("<Q", d) for d in shape)
        table += struct.pack("<IQ", type_id, offset)
        sizes.append(nbytes)
        offset = _pad(offset + nbytes)
    head = magic + struct.pack("<IQQ", version, len(tensors), len(metadata))
    head += b"".join(_str(k) + _value(v) for k, v in metadata.items()) + table
    head += b"\0" * (_pad(len(head)) - len(head))
    data = bytearray()
    for nbytes in sizes:
        data += b"\0" * nbytes
        data += b"\0" * (_pad(len(data)) - len(data))
    blob = head + bytes(data)
    path.write_bytes(blob[: len(blob) - cut] if cut else blob)
    return path


def glimmer_like(path: Path, *, vocab: int = 5000, file_type: int = 24, vision: bool = False, extra=(), **meta) -> Path:
    """An invented 'glimmer-test' model: 4 layers, 8 heads, 2 KV heads, mostly IQ1_S."""
    metadata = {
        "general.architecture": "glimmer-test",
        "general.name": "Invented Test Model",
        "general.file_type": file_type,
        "glimmer-test.block_count": 4,
        "glimmer-test.embedding_length": 256,
        "glimmer-test.attention.head_count": 8,
        "glimmer-test.attention.head_count_kv": 2,
        "tokenizer.ggml.tokens": [f"t{i}" for i in range(vocab)],
        "tokenizer.chat_template": "{{ reasoning_strength }}{% for m in messages %}{{ m.content }}{% endfor %}",
        **meta,
    }
    tensors = [("token_embd.weight", (256, 64), 12)]
    tensors += [(f"blk.{i}.attn_q.weight", (256, 256), 19) for i in range(4)]
    tensors += [("output_norm.weight", (256,), 0)]
    if vision:
        tensors += [("v.blk.0.attn_q.weight", (256, 32), 1), ("mm.0.weight", (256, 16), 1)]
    return write_gguf(path, metadata, [*tensors, *extra])
