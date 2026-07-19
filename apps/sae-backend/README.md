# SAE sidecar (apps/sae-backend)

The SAE half of the MI Workbench, as its **own service in its own venv** —
the isolation answer to a hard dependency conflict:

- `sae_lens` pins **older TransformerLens versions**. Installing it into
  `apps/mi-backend/.venv` would downgrade the TL that all 12 working probes
  depend on and break the workbench.
- So it lives here instead, with the **full sae_lens ecosystem** — the
  pretrained SAE registry, `HookedSAETransformer` (models run _with_ SAEs
  spliced in, enabling feature-level ablation/steering, not just reading),
  and Neuronpedia metadata — behind HTTP on **:8766**.

The two backends share nothing but HTTP and the same design contract:
degrade-to-stub with an honest note, never fabricate. If this service is
down or `sae_lens` isn't installed, the SAE probes in the UI render stub
data clearly labeled with why.

## Run

```
python3.13 -m venv .venv
.venv/bin/pip install -e '.[ml,dev]'    # sae_lens + its own TL/torch — big, one time
.venv/bin/uvicorn main:app --port 8766
```

`npm run workbench` at the repo root does all of this automatically.

## Memory note

When both backends are warm they each hold their own copy of the model
(gpt2: ~500 MB each) — acceptable for small models, and the honest cost of
true isolation.
