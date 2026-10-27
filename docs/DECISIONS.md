# Decisions

| Date | Decision | Why |
|---|---|---|
| Oct 27 | Glimmer itself is the router | Glimmer's "assistant" model is a DFlash speculative-decoding drafter (model_type muse_glimmer_assistant, 5 draft layers), not a chat model |
| Oct 27 | Development runs Glimmer on OpenRouter (`meta/muse-glimmer-30b`) | Ethan asked for cloud only for now; the Mac has about 15 GB free. Cloud mode only reads folders marked `.synthetic` |
| Oct 27 | Jetson model is `mradermacher/Muse-Glimmer-30B-i1-GGUF` i1-IQ1_S (6.5 GB), IQ1_M (7.1 GB) as the comparison | Ethan asked to use a published quant instead of making our own; i1 files are imatrix quants of the base model |
| Oct 27 | No Jetson board is pulled from the fleet yet | Ethan's call; the Jetson path is tested in simulation |
| Oct 27 | The laptop dials out to the Jetson for heavy steps | The Mac is a managed work laptop that must not listen on the network |
| Oct 27 | Roster is 24 students, not 20 | The demo grades 24 essays, one per student |
| Oct 27 | Dreaming defaults to the prompt backend (rules rewritten each night); LoRA training is a cloud script | OpenRouter cannot load a LoRA adapter, and no local training |
| Oct 27 | The relay is new code in relay/ deployed as its own Worker | All work has to be in this repo |
