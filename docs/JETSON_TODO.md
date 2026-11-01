# Jetson to-do

What needs a real board. There is no Jetson access yet, so nothing here has been run. Later units add to this list.

## One-bit Muse Glimmer on a Jetson Orin Nano

From `QUANT_TARGETS` (`docs/TRAINING.md`, "Device targets"). Until these are done, every page labels the file not run on a real board.

1. **Does it load?** Run the IQ1_S file on an 8 GB Orin Nano with llama.cpp at b11669 or later, in a clean boot. Record peak memory, and how much the OS leaves free. The closest stand-in so far, x86 CPU only on 6 threads under a hard cgroup limit with no swap (Nov 1, `docs/log/quant-run-2026-11-01`), loaded the 6.53 GB r30b base file under 8 GiB and 7 GiB with no out-of-memory event: 7.3 GB resident with mmap at a 4K context, 7.0 GB with `-lm none`. x86 under a limit isn't a Jetson. Try `-c 2048`, then partial GPU layers. Note that on b11669 `--no-mmap` is gone: it's `-lm none`.
2. **How fast is it?** Record tokens a second, and how long the first token takes. The x86 stand-in made about 2.4 tokens a second, with about 5 seconds to the first token.
3. **Is it usable?** No tuned adapter has passed the one-bit answer check yet, so there is no tuned file to bring. Tune on r30b first. Run the same held-out prompts as the job's answer check on the board, and compare with its results on the GPU.
4. **Then replace the copy.** Change `fit` in `deviceModelTarget` and `LOW_BIT_FACTS` in `lib/train/quant-targets.ts` to what was measured.

## Small Llama on other boards and devices

Tuned Llama 3.2 3B Q4_K_M: 2.02 GB, about 2.8 GB resident, about 23 tokens a second on 6 x86 threads, and 162 on an A10. None of this was on a phone or a board. Measure it on the real device, then replace `fit` in `deviceModelTarget`.

