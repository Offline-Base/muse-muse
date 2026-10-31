"""Read a GGUF file's header with the standard library, for scripts/plug_in_model.py --check.

Reads the metadata and the tensor table, never the weights, so it takes a moment even on a 6 GB
file (the sha256 reads the whole file). The tensor types are ggml.h's `enum ggml_type` up to
MXFP4 (39); any other id is reported as unknown, and plug_in_model refuses the file.
"""

from __future__ import annotations

import hashlib
import re
import struct
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ggml.h enum ggml_type: id -> (name, elements per block, bytes per block).
TYPES: dict[int, tuple[str, int, int]] = {
    0: ("F32", 1, 4), 1: ("F16", 1, 2), 2: ("Q4_0", 32, 18), 3: ("Q4_1", 32, 20),
    6: ("Q5_0", 32, 22), 7: ("Q5_1", 32, 24), 8: ("Q8_0", 32, 34), 9: ("Q8_1", 32, 36),
    10: ("Q2_K", 256, 84), 11: ("Q3_K", 256, 110), 12: ("Q4_K", 256, 144), 13: ("Q5_K", 256, 176),
    14: ("Q6_K", 256, 210), 15: ("Q8_K", 256, 292), 16: ("IQ2_XXS", 256, 66), 17: ("IQ2_XS", 256, 74),
    18: ("IQ3_XXS", 256, 98), 19: ("IQ1_S", 256, 50), 20: ("IQ4_NL", 32, 18), 21: ("IQ3_S", 256, 110),
    22: ("IQ2_S", 256, 82), 23: ("IQ4_XS", 256, 136), 24: ("I8", 1, 1), 25: ("I16", 1, 2),
    26: ("I32", 1, 4), 27: ("I64", 1, 8), 28: ("F64", 1, 8), 29: ("IQ1_M", 256, 56),
    30: ("BF16", 1, 2), 34: ("TQ1_0", 256, 54), 35: ("TQ2_0", 256, 66), 39: ("MXFP4", 32, 17),
}  # fmt: skip
# Ids llama.cpp dropped (the old repacked layouts are now made at load time): it cannot load them.
REMOVED = {4: "Q4_2", 5: "Q4_3", 31: "Q4_0_4_4", 32: "Q4_0_4_8", 33: "Q4_0_8_8", 36: "IQ4_NL_4_4",
           37: "IQ4_NL_4_8", 38: "IQ4_NL_8_8"}  # fmt: skip
# llama.h enum llama_ftype, the file's general.file_type: what the quantizer was asked for.
FILE_TYPES = {
    0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K",
    11: "Q3_K_S", 12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M",
    18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS", 21: "Q2_K_S", 22: "IQ3_XS", 23: "IQ3_XXS", 24: "IQ1_S",
    25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M", 28: "IQ2_S", 29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M",
    32: "BF16", 36: "TQ1_0", 37: "TQ2_0", 38: "MXFP4_MOE",
}  # fmt: skip

# GGUF metadata value types
_SCALARS = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
STRING, ARRAY = 8, 9
KEEP_ARRAY = 4096  # a longer array (the vocabulary) keeps only its length
MAX_COUNT = 10_000_000  # more tensors, keys or bytes in one string than this: not a real header
# Tensor names of a vision tower or projector (llama.cpp's clip naming, and the usual others).
_VISION = re.compile(r"^(?:v|mm)\.|vision|visual|mmproj|resampler")


class GGUFError(ValueError):
    """The file is not a GGUF this reader understands. The message is plain enough to show."""


@dataclass(frozen=True)
class Array:
    """A long metadata array: only its element type and length are kept."""

    type: int
    length: int


@dataclass(frozen=True)
class Tensor:
    name: str
    shape: tuple[int, ...]
    type_id: int
    offset: int

    @property
    def elements(self) -> int:
        n = 1
        for d in self.shape:
            n *= d
        return n

    @property
    def type_name(self) -> str:
        if self.type_id in TYPES:
            return TYPES[self.type_id][0]
        return REMOVED.get(self.type_id, f"unknown ({self.type_id})")

    @property
    def nbytes(self) -> int | None:
        """Bytes of data, or None for a type this reader does not know."""
        if self.type_id not in TYPES:
            return None
        _name, block, size = TYPES[self.type_id]
        return self.elements // block * size

    @property
    def vision(self) -> bool:
        return bool(_VISION.search(self.name))


@dataclass
class GGUF:
    path: Path
    version: int
    metadata: dict[str, Any]
    tensors: list[Tensor]
    data_start: int
    file_bytes: int = field(default=0)

    @property
    def arch(self) -> str:
        return str(self.metadata.get("general.architecture", ""))

    def arch_value(self, key: str, default: Any = None) -> Any:
        return self.metadata.get(f"{self.arch}.{key}", default)

    @property
    def file_type(self) -> str | None:
        ftype = self.metadata.get("general.file_type")
        return None if ftype is None else FILE_TYPES.get(ftype, f"unknown ({ftype})")

    @property
    def params(self) -> int:
        return sum(t.elements for t in self.tensors)

    @property
    def vision_tensors(self) -> list[Tensor]:
        return [t for t in self.tensors if t.vision]

    @property
    def vocab_size(self) -> int | None:
        tokens = self.metadata.get("tokenizer.ggml.tokens")
        if isinstance(tokens, Array):
            return tokens.length
        return len(tokens) if isinstance(tokens, list) else None

    def type_counts(self) -> Counter:
        """Tensor type name -> number of tensors."""
        return Counter(t.type_name for t in self.tensors)

    def bad_types(self) -> dict[int, str]:
        """Type ids llama.cpp cannot load (removed) or this reader does not know, with their names."""
        return {t.type_id: t.type_name for t in self.tensors if t.type_id not in TYPES}

    def short_tensors(self) -> int:
        """Tensors whose data would end past the end of the file (a cut-off copy or download)."""
        return sum(1 for t in self.tensors if t.nbytes is not None and self.data_start + t.offset + t.nbytes > self.file_bytes)

    def bits_per_weight(self, text_only: bool = False) -> float | None:
        """File bytes x 8 / parameters. text_only leaves the vision tensors out of both."""
        tensors = [t for t in self.tensors if not (text_only and t.vision)]
        params = sum(t.elements for t in tensors)
        size = self.file_bytes
        if text_only:
            vision = [t.nbytes for t in self.tensors if t.vision]
            if None in vision:
                return None
            size -= sum(vision)  # type: ignore[arg-type]
        return size * 8 / params if params else None

    def kv_cache_bytes(self, ctx: int, value_bytes: int = 2) -> int | None:
        """The KV cache at `ctx` tokens for one sequence, F16 by default (llama-server's cache type),
        from block_count, head_count_kv (one value or one per layer) and key/value length. An upper
        bound when the model has a sliding window. None when the metadata does not say."""
        layers = self.arch_value("block_count")
        heads = self.arch_value("attention.head_count")
        kv_heads = self.arch_value("attention.head_count_kv", heads)
        if not isinstance(layers, int) or kv_heads is None:
            return None
        per_layer = kv_heads if isinstance(kv_heads, list) else [kv_heads] * layers
        q_heads = max(heads) if isinstance(heads, list) else heads
        width = self.arch_value("embedding_length")
        key = self.arch_value("attention.key_length") or (width // q_heads if width and q_heads else None)
        value = self.arch_value("attention.value_length") or key
        if not key:
            return None
        return ctx * sum(per_layer) * (key + value) * value_bytes


class _Reader:
    def __init__(self, f):
        self.f = f

    def take(self, n: int) -> bytes:
        data = self.f.read(n)
        if len(data) != n:
            raise GGUFError("the file ends inside its header (is the copy complete?)")
        return data

    def scalar(self, kind: int) -> Any:
        fmt = _SCALARS[kind]
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))[0]

    def count(self) -> int:
        n = self.scalar(10)
        if n > MAX_COUNT:
            raise GGUFError("the header has an impossible count (not a GGUF this reader understands)")
        return n

    def string(self) -> str:
        return self.take(self.count()).decode("utf-8", "replace")

    def value(self, kind: int) -> Any:
        if kind == STRING:
            return self.string()
        if kind == ARRAY:
            inner, n = self.scalar(4), self.count()
            if n > KEEP_ARRAY:
                self.skip(inner, n)
                return Array(inner, n)
            return [self.value(inner) for _ in range(n)]
        if kind in _SCALARS:
            return self.scalar(kind)
        raise GGUFError(f"the header has an unknown value type {kind}")

    def skip(self, kind: int, n: int) -> None:
        if kind in _SCALARS:
            self.f.seek(struct.calcsize(_SCALARS[kind]) * n, 1)
        elif kind == STRING:
            for _ in range(n):
                self.f.seek(self.count(), 1)
        else:
            for _ in range(n):
                self.value(kind)


def read(path: str | Path) -> GGUF:
    """The header of the GGUF at `path`. Raises GGUFError with a plain reason."""
    path = Path(path)
    with path.open("rb") as f:
        r = _Reader(f)
        if f.read(4) != b"GGUF":
            raise GGUFError(f"{path.name} is not a GGUF file")
        version = r.scalar(4)
        if version not in (2, 3):
            if version > 0xFFFF:
                raise GGUFError(f"{path.name} is a big-endian GGUF, which this device cannot use")
            raise GGUFError(f"{path.name} is GGUF version {version}; only versions 2 and 3 are read")
        n_tensors, n_kv = r.count(), r.count()
        metadata = {}
        for _ in range(n_kv):
            key = r.string()
            metadata[key] = r.value(r.scalar(4))
        tensors = []
        for _ in range(n_tensors):
            name = r.string()
            dims = r.scalar(4)
            if dims > 8:
                raise GGUFError(f"tensor {name!r} has {dims} dimensions (not a GGUF this reader understands)")
            shape = tuple(r.scalar(10) for _ in range(dims))
            tensors.append(Tensor(name, shape, r.scalar(4), r.scalar(10)))
        align = metadata.get("general.alignment", 32)
        if not isinstance(align, int) or align <= 0:
            align = 32
        data_start = -(-f.tell() // align) * align
    return GGUF(path, version, metadata, tensors, data_start, path.stat().st_size)


def sha256(path: str | Path, chunk: int = 8 << 20) -> str:
    """The file's sha256, read in 8 MiB pieces."""
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def llama_build(binary: str | Path | None) -> int | None:
    """The build number `llama-server --version` prints ("version: 0.7.0 (build 11669, ...)" or
    the older "version: 4567 (abc123)"), or None when it cannot be run or read."""
    if not binary:
        return None
    try:
        out = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    text = out.stdout + out.stderr
    found = re.search(r"\bbuild (\d+)", text) or re.search(r"version: (\d+) \(", text)
    return int(found.group(1)) if found else None
