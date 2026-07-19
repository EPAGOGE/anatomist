# Verification harness — F-0 Criterion 3

Generates PyTorch source for four representative architectures, runs each
through a real torch environment to confirm it instantiates and forwards
correctly, and writes a JSON evidence artifact.

## Why this exists

Build doc Criterion 3 says generated PyTorch is _"verifiably functional."_
The word **verifiably** demands evidence — the code must actually run,
not just look right. This harness produces that evidence.

Per the F-0 brief, periodic-with-recorded-results is the pragmatic call.
The harness runs on demand; its JSON output (under `verification-results/`)
is the evidence the criterion demands.

## What it tests

Four fixtures (see `fixtures.ts`):

1. **gqa-decoder-block** — RMSNorm → GQA (RoPE) → GatedFFN (SwiGLU) →
   Output. Exercises GQA's grouped K/V projections, RoPE rotation, the
   Llama-family normalization, and SwiGLU.
2. **moe-ffn-block** — single MoEFFN with 4 experts, top-2 routing.
   Exercises the router, expert ModuleList, top-k dispatch.
3. **cross-attention-encdec** — two-input plumbing into CrossAttention
   with separate query and key/value streams.
4. **full-small-transformer** — integrated stack composing TokenEmbedding,
   AbsolutePositionEncoding, LayerNorm, MHA, FeedForward. Catches
   shape-threading bugs that individual-component tests miss.

## Running

```bash
# From repo root:
npm run -w @epagoge/api verify:codegen
```

The harness picks a Python interpreter in this order:

1. `$EPAGOGE_TORCH_PYTHON` if set
2. `apps/api/scripts/verify-generated-code/.torch-venv/bin/python` if present
3. `python3` from PATH

If torch isn't available in the chosen interpreter, each forward result is
recorded as `status: "skip"` — honest evidence that the codegen step ran
successfully but the functional verification awaits a torch environment.

## One-time torch setup (recommended)

```bash
cd apps/api/scripts/verify-generated-code
python3.13 -m venv .torch-venv
.torch-venv/bin/pip install torch
```

Substitute `python3.13` with whatever Python version has torch wheels
available for your platform. After this, `npm run verify:codegen` uses
the dedicated venv automatically.

## Output

Two files under `apps/api/verification-results/`:

- `verify-generated-code.latest.json` — latest run summary
- `verify-generated-code.history.jsonl` — append-only run history

Both contain per-fixture status (pass / skip / fail), elapsed time,
output shape, and reason for non-passes. The `latest.json` is the
artifact the criterion's evidence references.

## Exit codes

- `0` — every fixture either passed forward verification OR was skipped
  (torch missing). Codegen succeeded for all.
- `1` — at least one forward FAIL, or codegen failure on any fixture.

CI may run this with `EPAGOGE_TORCH_PYTHON` pointed at a prepared
interpreter; without that the harness still runs and records SKIPs.
