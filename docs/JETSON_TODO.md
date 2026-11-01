# Jetson to-do

What needs a real board. There is no Jetson access yet, so nothing here has been run. Later units add to this list.

## One-bit Muse Glimmer on a Jetson Orin Nano

From `QUANT_TARGETS` (`docs/TRAINING.md`, "Device targets"). Until these are done, every page labels the file not run on a real board.

1. **Does it load?** Run the tuned IQ1_S file on an 8 GB Orin Nano with llama.cpp at b11669 or later, in a clean boot. Record peak memory. The file measured 6.53 GB on the knowledge model; the 7.7 GB to run is an estimate; the earlier 70% device rule would allow only 5.6 GB. Try a smaller context, then mmap, then partial GPU layers.
2. **How fast is it?** Record tokens a second, and how long the first token takes.
3. **Is it usable?** Run the same held-out prompts as the job's answer check on the board, and compare with its results on the GPU.
4. **Then replace the copy.** Change `fit` in `deviceModelTarget` and `LOW_BIT_FACTS` in `lib/train/quant-targets.ts` to what was measured.
