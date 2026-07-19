# Routing cost measurement — F-0 Criterion 6

Measures the production router's cost efficiency against a naive
Opus-only baseline. Produces the JSON evidence the criterion demands.

## Why this exists

Build doc Criterion 6: _"Model routing operates correctly with
**measurable** cost efficiency versus naive Opus-only baseline."_
Build doc Section 3.4: _"Model routing demonstrably reduces cost."_

Both **measurable** and **demonstrably** require a number on a
representative workload, not a claim. This script produces that
number.

## What it does

Runs each workload query twice:

1. With the production router making the routing decision.
2. With `forceTier: 'opus'` (the naive baseline).

Records actual cost from `result.costNanos` per call. Aggregates
into total routed cost, total opus cost, savings delta, and savings
percentage. Reports per-query tier distribution so the spread is
visible.

## The workload (`workload.ts`)

15 queries spanning four categories:

- **Simple factual / classification** — short, isSimple=true, should
  route to Haiku.
- **Substantial reasoning / explanation** — should route to Sonnet
  typically.
- **Hard multi-step derivation** — may route to Opus.
- **Background-analysis** — bounded, validation explanations,
  summaries (Haiku/Sonnet).

Per ADR-0038 the workload spans tiers deliberately. Cases where
routing chooses Opus anyway are included; their "savings" are zero
by construction, which is the honest number, not a number flattered
by a workload of all-Haiku queries.

## Cache busting

Each call carries a per-run salt in its system prompt so the
aiResponseCache does NOT collapse identical messages into one cached
response. Without this, the second call (forced Opus) would hit the
routed result's cache and report $0 cost. The salt is one cheap
modification that makes the measurement honest.

## Running

```bash
# Requires ANTHROPIC_API_KEY and DATABASE_URL in environment.
npm run -w @epagoge/api measure:routing-cost
```

Approximate cost per run: $0.20-0.80 depending on actual workload
results and how often the router chooses cheaper tiers. The per-call
maxNanos cap is $0.50 to prevent runaways.

## Output

- `apps/api/verification-results/measure-routing-cost.latest.json` —
  the latest run summary with per-query breakdowns
- `apps/api/verification-results/measure-routing-cost.history.jsonl` —
  append-only run history

The `latest.json` is the evidence the criterion references. It feeds
Task 117 (cost analysis review for unit economics) later in F-1, so
its credibility matters twice.

## What the number means

A typical run on this workload should show:

- Most simple-factual queries routed to Haiku (large savings vs Opus)
- Most substantial-reasoning queries routed to Sonnet (moderate savings)
- Some hard-derivation queries route to Opus (no savings — the
  router correctly identifies these needing depth)

The aggregate savings percentage reflects the workload mix. A higher
percentage on a workload heavy with simple queries; lower on a
workload heavy with hard queries. The measurement is honest about
both shapes.

Task 117 takes this number and asks: at the planned subscription
price, do the AI costs leave a viable margin? That's where Phase 1
pricing gets validated.
