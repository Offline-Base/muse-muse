# A 12 GB phone that says no

A **constructed** kit output folder for `lib/devices/__tests__/result.test.ts`: the proof run of
`bartowski-iq2_xxs` (8.92 GB) on a 12 GB Galaxy S24 Ultra-like phone (Snapdragon 8 Gen 3, Android 15), as the kit
writes it. No phone made these files: their shapes follow the kit's contract and llama.cpp b11669's output, and the
numbers are plausible, not measured.

- The CPU bench (the plain build, flat) prints its pp line, then the low-memory killer ends it: rc 137, `why=lmk`, and
  `lmk-bench-cpu.txt` holds lmkd's lines naming its pid. MemAvailable falls from about 6 GB to about 210 MB first.
- The GPU bench (the Snapdragon build) can't allocate its OpenCL buffer: rc 1, `end=error`, and no JSONL. The error
  lines are in the shape of llama.cpp's.
- The NPU isn't listed (`list-npu.txt` has no `HTP0`), so it is skipped as unavailable. The Hexagon line in it is
  invented, standing in for whatever a retail phone says when it refuses an unsigned session.
- With no generation speed anywhere, every answer is skipped (`why=noload`), and the verdict is unusable.
