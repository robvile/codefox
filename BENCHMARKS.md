# CodeFox benchmarks

Known-good load settings and measured speeds, so tuning is never done from
memory. The baseline below is the configuration to beat — any change to the
load settings should be measured against it.

## How to read a result

LM Studio prints a timing line per generation slot. The number that matters
is `tg` (tokens generated per second). Paste the whole line when recording:

```
21.41.839.963 I slot print_timing: id  0 | task 612 | n_gen =   2227, tg =   2.55 t/s, tg_3s =   2.61 t/s
```

Record: date, CodeFox version, model (exact id), the six load settings if
they differ from the baseline, hardware, and the `tg` figure. One entry per
measurement — do not overwrite the baseline.

## Baseline (known-good settings)

These are the settings CodeFox applies whenever it loads a model
(`TUNED_LOAD_DEFAULTS` in `lmstudio-load.js`). They are the same recipe that
produced Inkwell's ~30 t/s and Marketing HQ's ~35 t/s on this hardware.

- K/V cache quantisation: `q8_0` (both K and V)
- Max concurrent predictions: `1`
- GPU offload: full (`offloadRatio 1`, KV cache offloaded to GPU)
- Context length: `16384`
- Eval batch size: `512`
- Flash attention: on

## Results

| Date | CodeFox | Model | Settings | Hardware | tg (t/s) | Notes |
|------|---------|-------|----------|----------|----------|-------|
| 2026-11-25 | 0.8.3 | Qwen3 Coder 30B A3B Instruct, Q4_K_M | Baseline (above) | RX 7900 XTX 24GB, 96GB RAM, Ryzen 9 X3D | **70** | Loaded through CodeFox Settings → Model. First tuned load. |
| 2026-11-25 | pre-0.8.3 | Unknown (not recorded) | Untuned — whatever LM Studio had loaded | Same | 2.55 | CodeFox before tuned loading existed; it used whatever model LM Studio had loaded with default settings. Model not recorded, so this is a rough before/after, not a controlled comparison. |
| 2026-11-25 | — (Marketing HQ) | Gemma-4 | Untuned (auto-loaded, defaults) | Same | 7.62 | Auto-loader set context 16384 + flash attention only; no KV quant, no parallel limit, partial offload. The model spilled to system RAM. |
| 2026-11-24 | — (Marketing HQ) | Qwen 3.8 27B | Tuned in LM Studio UI | Same | ~35 | Rob's earlier UI tuning; the recipe the baseline copies. |
| 2026-11-24 | — (Inkwell) | (model not recorded) | Tuned in LM Studio UI | Same | ~30 | Inkwell never loads models — it uses whatever LM Studio has loaded. Speed came from the UI tuning, not Inkwell's code. |

Why 70 t/s beats the old ~35: the Qwen3 Coder 30B A3B is a mixture-of-experts
model — 30B parameters total but only ~3B active per token — so it does far
less work per token than the dense 27B Qwen that hit ~35. Same settings,
lighter model. That is the likely explanation, not a measurement trick; the
`tg` figure comes from LM Studio's own timing line in both cases.

## Rules for changing the settings

- Never change the baseline settings silently. A new measurement with
  different settings gets a new row, and the baseline row stays.
- If a new row beats the baseline on the same model and hardware, that row
  becomes the new baseline — update `TUNED_LOAD_DEFAULTS` to match it and
  note the change here.
- If a model is not downloaded in LM Studio, CodeFox says so and loads
  nothing. Benchmarks only cover models that are actually on the machine.
