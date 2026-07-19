# Vendored: jlens (Jacobian-lens engine)

Vendored copy of the local J-lens engine from `~/jlens` (this repo's own
reference-faithful reimplementation), so the workbench's J-lens probe works on
any machine the repo is cloned to — not just the machine that happens to have
`~/jlens`.

- **What it implements:** the Jacobian lens from Gurnee, Sofroniew, Lindsey et
  al., _"Verbalizable Representations Form a Global Workspace in Language
  Models"_ (Transformer Circuits, 2026) —
  `lens(h_l) = softmax(W_U · norm(J_l h_l))` with
  `J_l = E[∂h_final/∂h_l]` averaged over `data/corpus_mini.txt`.
- **Contents:** `jlens/` (ModelTap, compute_jlens, Reader — 4 files) and
  `data/corpus_mini.txt` (the 40-sentence averaging corpus). Nothing else from
  `~/jlens` is vendored; in particular `anthropic_ref/` (the Apache-2.0
  reference implementation) is intentionally NOT copied — it is a one-time
  certification oracle, not a runtime dependency.
- **Caches:** per-model Jacobians (`jlens_*.pt`, ~30 MB each) are derived
  artifacts and are NOT committed. They regenerate on first probe run per
  model (a minute or two) into `apps/mi-backend/.cache/jlens/` (gitignored).
- **Overrides:** set `JLENS_PATH` to point the runtime at a development copy
  (e.g. `~/jlens`) and `JLENS_CACHE` to relocate the cache.
- **Refreshing:** if the engine at `~/jlens` changes, re-copy the four
  `jlens/*.py` files and `data/corpus_mini.txt` here. Changing the corpus
  bytes invalidates every cached Jacobian by design (the cache key
  fingerprints them).
