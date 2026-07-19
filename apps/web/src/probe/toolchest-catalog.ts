// Toolchest catalog — the intent-first probe definitions.
//
// This is the intellectual core of the learning layer (see
// docs/Learning_Layer.md). Each entry carries FOUR representations of one
// operation — concept, process, math, code — threaded together by shared
// CONCEPTS. The buttons are labeled by INTENT (what you're trying to do),
// never by Python function name.
//
// The math here is correct and the code actually runs against the backend.
// Teaching wrong math confidently is worse than teaching nothing.

import type { Icon } from '@phosphor-icons/react';
import {
  Eye,
  Pulse,
  Crosshair,
  Eraser,
  GridFour,
  Swap,
  Function,
  Sparkle,
  Compass,
  Binoculars,
  Target,
  Books,
  Scissors,
} from '@phosphor-icons/react';

export type ProbeVizKind =
  | 'attention-heatmap'
  | 'token-bars'
  | 'logit-list'
  | 'ablation-compare'
  | 'head-sweep'
  | 'patch-heatmap'
  | 'attribution-heatmap'
  | 'neuron-list'
  | 'direction-curve'
  | 'jlens-grid'
  | 'jlens-swap'
  | 'sae-feature-list'
  | 'sae-ablate'
  | 'token-heat-surprisal'
  | 'token-heat-unit'
  | 'generation-trace'
  | 'tokenizer'
  | 'head-census'
  | 'token-heat-saliency'
  | 'weight-lens'
  | 'max-activating'
  | 'model-diff';

export type ProbeCategory = 'inspection' | 'intervention' | 'features' | 'sae' | 'circuits';

/** Shared glossary — the thread that folds process ↔ math ↔ code together.
 *  A probe references concepts by id; the result card highlights each term
 *  wherever it appears and shows the gloss on hover. */
export interface Concept {
  id: string;
  /** The exact term as it appears in the prose/math/code (case-insensitive match). */
  term: string;
  /** Crisp one-line gloss — the "what," shown on hover. */
  gloss: string;
  /** The mechanistic insight — the "why it works this way" — shown when the
   *  concept chip is active. Clear, but not dumbed-down. */
  why: string;
}

export const CONCEPTS: Record<string, Concept> = {
  query: {
    id: 'query',
    term: 'query',
    gloss:
      'The vector a token emits to search the earlier tokens — "here is what I am looking for."',
    why: 'The model builds the query by multiplying the token’s residual vector by a learned matrix (W_Q), so the "question" is a learned readout of everything the token has gathered so far. A query never touches earlier tokens directly — it only meets them as dot products against their keys. Attention compares questions to offers, never raw content.',
  },
  key: {
    id: 'key',
    term: 'key',
    gloss: 'The vector each earlier token emits so it can be found — "here is what I contain."',
    why: 'Keys live in the same space as queries so that the dot product query·key means something: a large value says "this offer answers that question." Crucially, a token’s key (how findable it is) is separate from its value (what it actually hands over) — which is exactly what lets one head locate the previous token yet copy something unrelated.',
  },
  softmax: {
    id: 'softmax',
    term: 'softmax',
    gloss:
      'Turns a row of raw scores into positive weights that sum to 1 — a soft, trainable pick.',
    why: 'It exponentiates each score then normalizes, so the largest dominates but nothing is ever exactly zero — a soft argmax. The exponential turns small score gaps into large weight gaps (attention is sharper than the raw scores look), and because it is smooth, gradients flow through the choice — so the model can learn which token to attend to, not just how to use it.',
  },
  pattern: {
    id: 'pattern',
    term: 'pattern',
    gloss:
      'The post-softmax grid of attention weights — each row a token doing the looking, each entry how much it draws from an earlier one.',
    why: 'This is the head’s decision made legible — the one part of attention you can read directly as "who looked at whom." It is lower-triangular (a token cannot attend to the future) and every row sums to 1. Reading patterns is how you first guess a head’s job: a stripe just below the diagonal is a previous-token head; a bright column is a token everyone leans on (often the attention sink).',
  },
  residual: {
    id: 'residual',
    term: 'residual stream',
    gloss:
      'The running vector each token carries down the layers — a shared bus every component reads from and adds back into.',
    why: 'This is the model’s backbone. Every head and MLP reads the current residual, computes something, and adds its output back — nothing is overwritten, only accumulated. So the residual is a running sum of contributions, which is exactly why it can be split apart (attribution) and spliced (patching): it is linear. Read through the unembedding, the final residual is the prediction.',
  },
  norm: {
    id: 'norm',
    term: 'norm',
    gloss: 'A vector’s length, √(Σ xᵢ²) — how far it reaches from zero, regardless of direction.',
    why: 'In the residual stream, norm roughly tracks how much is going on for a token at a layer, and it tends to grow with depth as components pile on. But norm is only magnitude — two vectors of equal length can point in completely different directions and mean completely different things. Direction carries the content; norm carries the loudness.',
  },
  unembedding: {
    id: 'unembedding',
    term: 'unembedding',
    gloss:
      'The matrix (W_U) that turns a residual vector into one raw score — a logit — for every token in the vocabulary.',
    why: 'Think of it as a stack of vocabulary directions, one row per token; a word’s logit is just the dot product of the final residual with that word’s direction. So "predicting a word" literally means "having a residual that points toward it." Applying W_U to a mid-layer residual is the logit lens — but only after the final LayerNorm, or the probabilities come out miscalibrated (a lesson we earned).',
  },
  ablation: {
    id: 'ablation',
    term: 'ablation',
    gloss:
      'Forcing a component’s output to zero and re-running — a knockout test for whether behavior actually depends on it.',
    why: 'Ablation measures a component’s total causal effect: everything downstream that relied on it, directly or through later layers. That is its strength and its trap — an early component looks enormous because its damage cascades through every layer after it, even when it does not carry the specific signal. When ablation and direct attribution disagree, the gap between them is that indirect, cascaded effect.',
  },
  head: {
    id: 'head',
    term: 'head',
    gloss:
      'One attention head — an independent read/move unit that decides where to look (query·key) and what to carry over (value).',
    why: 'A layer runs many heads in parallel, each with its own small Q/K/V matrices, and they simply add their outputs into the residual. Independence is the point: one can be a previous-token head, another an induction head, without interfering. Most heads do little on any given input, so the craft is finding the few that matter — which is why we sweep and ablate instead of eyeballing all of them.',
  },
  patching: {
    id: 'patching',
    term: 'patching',
    gloss:
      'Copying one run’s activation into another at a chosen spot, then measuring how far the output moves — a causal "does the signal live here?" test.',
    why: 'Run a clean and a corrupted prompt that differ in one thing, then splice the clean activation into the corrupted run at one (layer, position). Whatever both prompts share — the attention sink, the early cascade — cancels, because it is identical in both; what is left moving the answer is the real mechanism. It is the cleanest causal localizer we have short of retraining.',
  },
  attribution: {
    id: 'attribution',
    term: 'attribution',
    gloss:
      'Splitting the final logit-difference into the signed, direct contribution each component wrote toward it.',
    why: 'Because the residual is a sum of component outputs and the logit is a linear readout of it, the logit is a sum too — so each head and MLP gets an exact number for how hard it pushed one token over another. Unlike ablation, this counts only the direct path to the output, so cascade-heavy early components score near zero. Sign is the tell: positive pushed toward the answer, negative against it — how you catch a component quietly walking a prediction back.',
  },
  neuron: {
    id: 'neuron',
    term: 'neuron',
    gloss:
      'A single hidden unit in a layer’s MLP — one of the ~3,000 dimensions of its activation vector, with its own learned in- and out-directions.',
    why: 'A neuron "fires" more or less (its post-activation value) depending on the token, and historically it was THE unit of interpretability. The catch is superposition: a network represents far more features than it has neurons, so most neurons are polysemantic — one unit lights up for several unrelated things. That gap is exactly what sparse autoencoders were built to close.',
  },
  mlp: {
    id: 'mlp',
    term: 'MLP',
    gloss:
      'The per-token feed-forward block in each layer: expand to a wide hidden layer, apply a nonlinearity, project back.',
    why: 'Attention moves information between tokens; the MLP processes each token in place. It expands the residual to ~4× width (3,072 units for GPT-2), applies a nonlinearity (GELU), and adds the result back. A great deal of a model’s factual and feature computation happens here — this session’s late-layer calibration was MLP work.',
  },
  jacobian: {
    id: 'jacobian',
    term: 'Jacobian',
    gloss:
      'The matrix of "how much does each output dimension move when I nudge each input dimension" — here, how the final residual responds to a layer’s residual.',
    why: 'The logit lens pretends a mid-layer residual IS the final one (J = I) — often wrong, because later layers keep transforming it. The Jacobian lens instead measures, by backpropagation averaged over a small corpus, how mid-layer content ACTUALLY flows to the end (J_l = E[∂h_final/∂h_l]), then reads the residual through that learned map. Same unembedding, but the vector is first pushed through the model’s real downstream transformation — which is why it recovers interpretable content layers deeper.',
  },
  workspace: {
    id: 'workspace',
    term: 'workspace',
    gloss:
      'The token content that is poised in the residual stream at a (layer, position) — present and ready, even when it is not yet the prediction.',
    why: 'A model can hold "red" in its stream at 64% depth while still predicting grammar words at the output — the content exists before it is used. Reading the workspace per layer and position shows ideas assembling: planet names surfacing mid-network, color words converging late. The term comes from the global-workspace reading of the Jacobian-lens work: verbalizable content forms a shared workspace across the stream.',
  },
  direction: {
    id: 'direction',
    term: 'concept direction',
    gloss:
      'A line in activation space separating examples OF a concept from examples of its contrast — built as the difference of the two groups’ means.',
    why: 'If the model represents a distinction linearly (and remarkably often it does), the axis pos−neg points along it, and any prompt’s alignment with that axis reads out where it falls. Centering at the two groups’ midpoint first is essential: raw residuals of any two sentences are ~99% similar (shared position/syntax mass), and centering cancels that shared part so only the concept-relevant component is scored. This same axis, added back INTO the stream, is a steering vector — read and write are the same direction.',
  },
  sae: {
    id: 'sae',
    term: 'SAE',
    gloss:
      'A sparse autoencoder: a learned dictionary that re-expresses an activation as a few active features out of tens of thousands — the un-mixing answer to superposition.',
    why: 'Train a wide autoencoder on millions of residual activations with a sparsity penalty, and it discovers the directions the model actually reuses — expanding ~768 dims into ~24,576 features of which only a few dozen fire at once. Each feature is (mostly) one concept, where a neuron is many. The reconstruction error is the honesty term: an SAE only earns trust if decode(encode(x)) ≈ x, which is why the FVU is shown on every readout. These probes run in their own sidecar service so sae_lens’s pinned dependencies can never touch the main workbench.',
  },
  gradient: {
    id: 'gradient',
    term: 'gradient',
    gloss:
      'The direction and rate of steepest change: how much the output would move if you nudged each input dimension. The same signal that trains the model, reused as a measuring tool.',
    why: 'One backward pass computes ∂(target logit)/∂(everything) simultaneously — that’s backpropagation, and it works as instrumentation, not just training. A large gradient at an input token means the answer is SENSITIVE there: wiggle that embedding, the answer moves. Caveat learned live in this workbench: the popular grad×input variant cancels itself under LayerNorm (it buried the Eiffel tokens); the gradient’s plain magnitude was faithful. First-order only — for exact answers, ablate.',
  },
  tokenization: {
    id: 'tokenization',
    term: 'tokenization',
    gloss:
      'The chopping of text into the pieces the model actually reads — learned subword units with ids, where a leading space is PART of the token, not decoration.',
    why: 'Models never see words. A byte-pair tokenizer, trained by pure frequency before the model ever existed, decides the units — so ‘poised’ and ‘ poised’ are two unrelated tokens with unrelated embeddings (the source of this workbench’s own worst instrument bug), and ‘2026’ fragments into ‘20’+‘26’, which is a big part of why arithmetic is hard. When a probe result looks inexplicable, check the tokenization FIRST: a large share of ‘the model is being weird’ mysteries are actually ‘the input wasn’t what you thought’.',
  },
  induction: {
    id: 'induction',
    term: 'induction',
    gloss:
      'The two-head circuit that finds the last time the current token appeared and copies whatever came next: [A][B] … [A] → predict [B].',
    why: 'The founding discovered circuit of mechanistic interpretability. A previous-token head (early layer) writes “what came before me” into each position’s record; an induction head (later layer) then matches the current token against those records and attends one step PAST the match — literally looking up “last time I saw this, what followed?”. It is the mechanical basis of in-context learning, it emerges abruptly mid-training (the “induction bump”), and it is why the surprisal probe shows repeated text going calm. The census scores every head for both roles on a random repeated sequence, where induction is the ONLY way to predict the second half.',
  },
  surprisal: {
    id: 'surprisal',
    term: 'surprisal',
    gloss:
      'How surprised the model was to see a token: -log2 of the probability it assigned, in bits. 0 bits = it knew; 20+ bits = its expectations were violated.',
    why: 'Surprisal IS the training loss, per token — the exact quantity the model spent its whole life minimizing. Averaged over a corpus it becomes cross-entropy; visualized over one text it becomes a diagnostic: near-zero spans read as easy or memorized, spikes mark where the model’s world-model broke. For intuition: one bit is one fair-coin flip of surprise, so a 24-bit token was a one-in-sixteen-million event by the model’s lights.',
  },
  entropy: {
    id: 'entropy',
    term: 'entropy',
    gloss:
      'The model’s uncertainty over its ENTIRE next-token distribution, in bits — high before wide-open choices, near zero when the next token is effectively forced.',
    why: 'Where surprisal grades one outcome after the fact, entropy measures the whole field of possibilities before the choice: H = -Σ p·log2 p. It is the knob temperature actually interacts with — sampling only matters at high-entropy moments; at 0.9 bits the distribution has already collapsed and every temperature gives the same token. Watching entropy breathe across a generation shows where the model is deciding versus merely transcribing.',
  },
  superposition: {
    id: 'superposition',
    term: 'superposition',
    gloss:
      'Packing more features than there are neurons by letting features share overlapping directions — why single neurons are usually polysemantic.',
    why: 'A model has thousands of neurons but represents tens of thousands of features, so it stores them as overlapping directions rather than one-per-neuron. The upside is capacity; the downside is that reading a single neuron rarely reveals a single clean concept. Sparse autoencoders un-mix superposition by learning a wider, sparse dictionary of directions — the natural next probe in this category.',
  },
};

export interface ProbeInputSpec {
  /** Which shared control this probe reads: layer, head, or top_k. */
  key: 'layer' | 'head' | 'top_k';
  label: string;
}

export interface ProbeDefinition {
  id: string;
  /** The button label — goal-framed, in the user's words. */
  intent: string;
  /** Secondary technical-ish name. */
  shortLabel: string;
  category: ProbeCategory;
  icon: Icon;

  /** One paragraph: what this is and why you'd want it. */
  concept: string;
  /** Plain-language narration of what just happened. Concept terms appear
   *  verbatim so the card can highlight them. */
  process: string;
  /** The operation in notation. */
  math: { expression: string; note: string };
  /** Python with {layer} / {head} / {top_k} placeholders. */
  codeTemplate: string;

  /** Concept ids (into CONCEPTS) that thread this probe's three lower layers. */
  concepts: string[];

  /** Which shared controls this probe uses. */
  inputs: ProbeInputSpec[];

  endpoint: string;
  viz: ProbeVizKind;
}

export const PROBES: ProbeDefinition[] = [
  {
    id: 'attention-pattern',
    intent: 'See which words a head pays attention to',
    shortLabel: 'Attention pattern',
    category: 'inspection',
    icon: Eye,
    concept:
      'An attention head is the model deciding, for each word, which earlier words to look at. This shows you that decision as a grid: each row is a word doing the looking, each bright cell is a word it looked at.',
    process:
      "Every word produced a query ('what am I looking for?') and every word produced a key ('what do I offer?'). We scored each query against each key, then ran a softmax so each row's scores add up to 1. That normalized grid is the attention pattern you see.",
    math: {
      expression: 'A = softmax( Q·Kᵀ / √dₖ )',
      note: 'Q and K are the query and key matrices; their dot product scores how well each query matches each key; dividing by √dₖ keeps the numbers stable; softmax turns each row of scores into weights that sum to 1.',
    },
    codeTemplate:
      "logits, cache = model.run_with_cache(prompt)\npattern = cache['blocks.{layer}.attn.hook_pattern'][0, {head}]  # [query, key]",
    concepts: ['query', 'key', 'softmax', 'pattern'],
    inputs: [
      { key: 'layer', label: 'Layer' },
      { key: 'head', label: 'Head' },
    ],
    endpoint: '/probe/attention_pattern',
    viz: 'attention-heatmap',
  },
  {
    id: 'activation-strength',
    intent: 'Feel how loud each word is at a layer',
    shortLabel: 'Activation strength',
    category: 'inspection',
    icon: Pulse,
    concept:
      'As a word moves through the model it carries a vector — its meaning-so-far. The length of that vector is a rough sense of how much is going on for that word at this layer. Tall bars mean the model is doing a lot with that token here.',
    process:
      "We grabbed the residual stream — the running vector for each word at this layer — and measured each one's norm (its length). Longer vector, taller bar.",
    math: {
      expression: '‖ x_t ‖₂ = √( Σᵢ x_{t,i}² )',
      note: 'x_t is the residual vector for token t; we square each component, sum them, and take the square root — the geometric length of the vector.',
    },
    codeTemplate:
      "logits, cache = model.run_with_cache(prompt)\nresid = cache['blocks.{layer}.hook_resid_post'][0]   # [token, d_model]\nnorms = resid.norm(dim=-1)                            # one length per token",
    concepts: ['residual', 'norm'],
    inputs: [{ key: 'layer', label: 'Layer' }],
    endpoint: '/probe/activations',
    viz: 'token-bars',
  },
  {
    id: 'logit-lens',
    intent: 'Peek at what the model would say if it stopped here',
    shortLabel: 'Logit lens',
    category: 'inspection',
    icon: Crosshair,
    concept:
      "The model builds its answer gradually, layer by layer. The logit lens cheats: it takes the half-finished vector at a middle layer and asks the output head 'if you had to guess the next word right now, what would it be?' Watching this across layers shows the answer forming.",
    process:
      "We took the residual stream at this layer, projected it straight through the model's unembedding (the output-vocabulary matrix), and ran a softmax to get probabilities. These are the model's best guesses for the next word, as of this layer.",
    math: {
      expression: 'p = softmax( W_U · x_L )',
      note: 'x_L is the residual at layer L; W_U is the unembedding matrix that maps a vector to a score per vocabulary word; softmax turns those scores into probabilities.',
    },
    codeTemplate:
      "logits, cache = model.run_with_cache(prompt)\nresid = cache['blocks.{layer}.hook_resid_post'][0, -1]  # last token\nguess = (resid @ model.W_U).softmax(-1).topk({top_k})",
    concepts: ['residual', 'unembedding', 'softmax'],
    inputs: [
      { key: 'layer', label: 'Layer' },
      { key: 'top_k', label: 'Top-k' },
    ],
    endpoint: '/probe/logit_lens',
    viz: 'logit-list',
  },
  {
    id: 'jlens-readout',
    intent: 'Read the workspace deeper than the logit lens',
    shortLabel: 'J-lens readout',
    category: 'inspection',
    icon: Binoculars,
    concept:
      "The logit lens asks each layer 'what would you say if you stopped here?' — but it reads mid-layer content as if no further processing existed, so deep layers often look like noise. The J-lens first pushes each layer's residual through the model's measured downstream transformation (the averaged Jacobian to the final layer), THEN reads it out — recovering the workspace: token content that is poised layers before it becomes the prediction. Runs your own local jlens engine against the raw model, so it works for any model you connect. First run per model computes the Jacobian (a minute or two); it is cached after.",
    process:
      'We built (or loaded from cache) the averaged Jacobian J for every probe layer — how this model’s final residual actually responds to each layer’s residual, measured by backpropagation over a mini corpus. Then, for your prompt, each (layer, position) residual was pushed through its J, normed, and read through the unembedding. The grid shows what token content is poised in the workspace everywhere at once — watch a column converge toward the answer as depth grows.',
    math: {
      expression: 'lens(h_ℓ) = softmax( W_U · norm( J_ℓ h_ℓ ) ),   J_ℓ = E[ ∂h_final / ∂h_ℓ ]',
      note: 'h_ℓ is the residual at layer ℓ; J_ℓ is the Jacobian of the final residual with respect to it, averaged over positions and a small corpus; norm is the model’s own final norm; W_U the unembedding. The logit lens is the special case J = I — no downstream transformation at all.',
    },
    codeTemplate:
      'tap = ModelTap(model_id)                     # raw HF model, arch-generic\nJ = compute_jlens(tap, corpus, cache_dir)    # averaged ∂h_final/∂h_l (cached)\nreader = Reader(tap, J)\npayload = reader.readout_grid(prompt, top_k=6)  # (layer × pos) workspace',
    concepts: ['jacobian', 'workspace', 'residual', 'unembedding'],
    inputs: [],
    endpoint: '/probe/jlens',
    viz: 'jlens-grid',
  },
  {
    id: 'jlens-swap',
    intent: 'Swap a thought and watch the answer change',
    shortLabel: 'Lens-coordinate swap',
    category: 'intervention',
    icon: Swap,
    concept:
      "The workspace paper's causal workhorse. Put the concept currently in the model's workspace in the Answer field and the concept to swap in under vs. (contrast box), then run: the source thought's lens coordinates are exchanged for the target's across the workspace layer band, and the model keeps talking. If the continuation follows the swapped thought — red becomes blue — you've shown the thought was causally load-bearing, not just present. Swaps mostly fail when the source is only weakly loaded in the workspace: pin it on the J-lens grid first to check its rank.",
    process:
      'We built each concept’s lens direction (the residual-space vector the lens reads as that token), read the activation’s coordinates along both directions at every position across the workspace band, exchanged them, and left everything orthogonal to the two directions untouched. Then the model generated a continuation from the modified state, shown next to the clean one. Same prompt, same weights — only the thought changed.',
    math: {
      expression: 'h ← h + V(σ(c) − c),   c = V⁺h,   V = [v_s  v_t]',
      note: 'v_s and v_t are the source and target lens directions at each layer; V⁺ is the pseudoinverse, so c is the activation’s coordinates along the two; σ swaps them. Everything outside span{v_s, v_t} is untouched — the surgical property that makes the intervention interpretable.',
    },
    codeTemplate:
      'V = stack([v_source, v_target], dim=1)      # lens directions at layer l\nc = pinv(V) @ h                              # lens coordinates\nh = h + V @ (swap(c) - c)                    # exchange the two thoughts\ncontinue_generation(h)                       # clean vs swapped, side by side',
    concepts: ['jacobian', 'workspace', 'patching'],
    inputs: [],
    endpoint: '/probe/jlens_swap',
    viz: 'jlens-swap',
  },
  {
    id: 'ablate-head',
    intent: 'Find out if a head actually matters',
    shortLabel: 'Head ablation',
    category: 'intervention',
    icon: Eraser,
    concept:
      "Inspection shows you what a head looks at. Ablation tells you if it matters. You switch the head off — force its output to zero — and re-run. If the prediction barely changes, this head wasn't pulling weight for this input. If it lurches, you found a head that mattered. Most heads, on most inputs, do little — finding the ones that do is the whole game.",
    process:
      'We ran your prompt twice. First clean. Then we set this head’s output (its z) to zero — switching it off — and ran again. The two next-word predictions, side by side, show exactly what this head was contributing. Same lists mean it didn’t matter here; a changed list means it did.',
    math: {
      expression: 'z[ℓ,h] ← 0,  then finish the forward pass',
      note: 'z is a head’s output — the information it writes back into the residual stream. Forcing it to zero removes this head’s contribution while leaving everything else intact, so any change in the prediction is attributable to this head alone (this is ablation).',
    },
    codeTemplate:
      "clean = model(tokens)[0, -1]\ndef off(z, hook): z[:, :, {head}, :] = 0; return z\nablated = model.run_with_hooks(tokens,\n    fwd_hooks=[('blocks.{layer}.attn.hook_z', off)])[0, -1]",
    concepts: ['ablation', 'head', 'residual'],
    inputs: [
      { key: 'layer', label: 'Layer' },
      { key: 'head', label: 'Head' },
      { key: 'top_k', label: 'Top-k' },
    ],
    endpoint: '/probe/ablate_head',
    viz: 'ablation-compare',
  },
  {
    id: 'head-sweep',
    intent: 'Rank every head by how much it matters',
    shortLabel: 'Head importance sweep',
    category: 'intervention',
    icon: GridFour,
    concept:
      'Hunting heads one at a time is slow. This switches off every head in the model, one at a time, and ranks them by how much each one changed the prediction. One click hands you the heads that matter for this input instead of making you guess coordinates — the practical way to find where the work is happening.',
    process:
      'We ran the clean prompt once to get the model’s answer, then ablated each attention head in turn and measured how far the prediction moved — its KL divergence from clean. Bright cells in the grid are heads that mattered; the list ranks the biggest movers.',
    math: {
      expression: 'effect(ℓ,h) = KL( clean ‖ ablate(ℓ,h) )',
      note: 'For each head we zero it, re-run, and measure the KL divergence between the clean next-token distribution and the ablated one — a single number for how much that head’s removal changed the model’s answer. Bigger means the head mattered more.',
    },
    codeTemplate:
      "clean = model(tokens)[0, -1].log_softmax(-1)\nfor L in range(n_layers):\n  for H in range(n_heads):\n    abl = model.run_with_hooks(tokens,\n      fwd_hooks=[(f'blocks.{L}.attn.hook_z', zero(H))])[0, -1].log_softmax(-1)\n    effect[L, H] = (clean.exp() * (clean - abl)).sum()   # KL",
    concepts: ['ablation', 'head', 'softmax'],
    inputs: [],
    endpoint: '/probe/ablate_sweep',
    viz: 'head-sweep',
  },
  {
    id: 'activation-patching',
    intent: 'Find where the answer actually lives',
    shortLabel: 'Activation patching',
    category: 'intervention',
    icon: Swap,
    concept:
      "Two prompts that differ in one thing — one word, one name — take different paths through the model. Run the 'wrong' one, then splice the 'right' one's internal state in at each spot; wherever splicing flips the answer back is where that information lives. Because both prompts share the attention sink and the early-layer cascade, those cancel — only the real difference survives. This is the principled answer to 'is that just the expected artifact?'",
    process:
      'We ran the corrupted prompt and the clean one, then for every layer and token position we patched the clean residual into the corrupted run and measured how far the answer flipped back toward the clean one. Bright cells are where the information distinguishing the two answers is carried — and the attention sink and early-layer cascade that both prompts share have cancelled out.',
    math: {
      expression: 'score(ℓ,p) = [ LD(patch) − LD(corrupt) ] / [ LD(clean) − LD(corrupt) ]',
      note: 'LD is the logit difference between the two answer tokens. Patching the clean residual into the corrupted run at (layer ℓ, position p) and renormalizing gives 0 for "no effect" and 1 for "fully restored the clean answer" — so bright means the information lives there.',
    },
    codeTemplate:
      "_, clean_cache = model.run_with_cache(clean_tokens)\nfor L in range(n_layers):\n  for p in range(seq_len):\n    patched = model.run_with_hooks(corrupted_tokens,\n      fwd_hooks=[(f'blocks.{L}.hook_resid_post', patch_at(p, clean_cache))])\n    score[L, p] = (logit_diff(patched) - corrupt_ld) / (clean_ld - corrupt_ld)",
    concepts: ['patching', 'residual'],
    inputs: [],
    endpoint: '/probe/patch',
    viz: 'patch-heatmap',
  },
  {
    id: 'logit-attribution',
    intent: 'Pin which part writes the answer',
    shortLabel: 'Direct logit attribution',
    category: 'intervention',
    icon: Function,
    concept:
      "The sweep tells you which head, removed, most changes the answer — but that's dominated by the early-layer cascade. This asks a sharper question: which component writes the answer DIRECTLY into the output? Each attention head and each MLP gets one signed number — positive if it pushes toward your target word, negative if it pushes toward the other. Cascade heads that only act indirectly score near zero, so the real writers stand out.",
    process:
      "Set your two words in the contrast box (Answer and vs. — e.g. ' poised' vs ' now'). We projected every head's and every MLP's direct output onto the direction that separates those two words in the output, giving each a signed attribution: warm cells push toward your Answer, cool cells push toward the other; size is how hard. The biggest writers are ranked beside the grid.",
    math: {
      expression: 'attr(c) = ( centered(out_c) · ( W_U[:,a] − W_U[:,b] ) ) / scale',
      note: 'out_c is one component’s contribution to the final residual; W_U[:,a]−W_U[:,b] is the unembedding direction separating the two answer tokens; the dot product is how hard that component pushed the logit-difference, signed; dividing by the final-layer scale puts every component in the same units.',
    },
    codeTemplate:
      "logits, cache = model.run_with_cache(tokens)\nd = model.W_U[:, a] - model.W_U[:, b]            # logit-diff direction\nfor L in range(n_layers):\n  z = cache[f'blocks.{L}.attn.hook_z'][0, -1]     # per-head outputs\n  for h in range(n_heads):\n    attr[L, h] = (z[h] @ model.W_O[L, h]) @ d     # direct push, signed",
    concepts: ['attribution', 'unembedding', 'residual'],
    inputs: [],
    endpoint: '/probe/logit_attribution',
    viz: 'attribution-heatmap',
  },
  {
    id: 'neuron-firings',
    intent: 'See which neurons fire on each word',
    shortLabel: 'Neuron activations',
    category: 'features',
    icon: Sparkle,
    concept:
      'Before sparse autoencoders, the neuron was the unit of "features." This reads how hard each MLP neuron fires on each token and ranks the strongest neuron-on-token firings — a first look at what individual units respond to. Keep superposition in mind: a big firing tells you a neuron reacted to that word, not that the neuron means only that word.',
    process:
      'We ran your prompt and read every MLP neuron’s post-activation value at every token, then ranked the strongest neuron-on-token firings. A tall bar means that neuron responded hard to that word. Because of superposition, one neuron usually answers to several unrelated features — so treat these as leads, not labels.',
    math: {
      expression: 'aₜ,ₙ = GELU( xₜ · W_in + b )ₙ',
      note: 'xₜ is the residual for token t; W_in expands it into the wide MLP hidden layer; GELU is the nonlinearity; aₜ,ₙ is neuron n’s activation on token t. We rank these across every (token, neuron) pair.',
    },
    codeTemplate:
      "logits, cache = model.run_with_cache(prompt)\nacts = cache['blocks.{layer}.mlp.hook_post'][0]   # [token, neuron]\ntop = acts.flatten().topk({top_k})                # strongest firings",
    concepts: ['neuron', 'mlp', 'superposition'],
    inputs: [
      { key: 'layer', label: 'Layer' },
      { key: 'top_k', label: 'Top-k' },
    ],
    endpoint: '/probe/neurons',
    viz: 'neuron-list',
  },
  {
    id: 'concept-direction',
    intent: 'Track where a concept emerges, layer by layer',
    shortLabel: 'Concept direction',
    category: 'features',
    icon: Compass,
    concept:
      "Give a few examples OF a concept and a few of its contrast (in the contrast box — separate several with |), and this builds the axis between them in the model's own activation space, then scores your prompt against it at every layer. The shape is the finding: near-zero early, rising through the middle layers, means you are watching the model build the distinction. Ported from your belief-lab contrast probe — the same difference-of-means primitive, now reading the model's own residual stream instead of an external embedding space.",
    process:
      'For each layer we averaged the residual stream over your concept examples and over your contrast examples — two centroids — and took their difference as the concept axis. Then we centered your prompt’s residual at the two centroids’ midpoint and measured its cosine with the axis, layer by layer. Warm bars lean toward the concept, cool toward the contrast; the layer where the bars take off is where the model starts representing the distinction.',
    math: {
      expression: 'score(ℓ) = cos( x_ℓ − μ_ℓ ,  pos_ℓ − neg_ℓ )',
      note: 'pos_ℓ and neg_ℓ are the mean residual vectors of the two example groups at layer ℓ (difference-of-means); μ_ℓ is their midpoint; x_ℓ is your prompt’s residual. Centering at μ cancels what all sentences share, so the cosine reads only the concept-relevant component.',
    },
    codeTemplate:
      'pos = stack([resid(p) for p in pos_examples]).mean(0)  # [layer, d_model]\nneg = stack([resid(n) for n in neg_examples]).mean(0)\nx = resid(prompt)\nfor L in range(n_layers):\n  score[L] = cos(x[L] - (pos[L]+neg[L])/2, pos[L] - neg[L])',
    concepts: ['direction', 'residual', 'superposition'],
    inputs: [],
    endpoint: '/probe/concept_direction',
    viz: 'direction-curve',
  },
  {
    id: 'surprisal',
    intent: 'See where the model is surprised',
    shortLabel: 'Token surprisal',
    category: 'inspection',
    icon: Binoculars,
    concept:
      'Read text through the model’s eyes. Every token is colored by how surprised the model was to see it — which is literally its training loss, made visible. Calm spans are text the model finds easy (or has memorized); red spikes are where its expectations broke, and hovering shows what it expected instead. Try a sentence that repeats itself: the second occurrence goes calm because the model learned from earlier in your own prompt — induction, visible with no instruments at all.',
    process:
      'One forward pass over your text. At every position the model emits a probability for each possible next token; we looked up the probability it gave to the token that ACTUALLY came next and took -log2 of it — bits of surprise. The hover shows the model’s top alternatives at that moment. The first token has no context, so it renders neutral.',
    math: {
      expression: 'surprisal(tₜ) = −log₂ p(tₜ | t₁…tₜ₋₁)',
      note: 'This is the per-token training loss (cross-entropy uses the natural log; same quantity, different units). One bit = one coin-flip of surprise: a 10-bit token was a 1-in-1024 event to the model, a 24-bit token one-in-sixteen-million.',
    },
    codeTemplate:
      'logits = model(tokens)                # [T, vocab]\nlogprobs = log_softmax(logits, dim=-1)\n# probability the model gave the token that actually came next\nbits = -logprobs[t - 1, tokens[t]] / log(2)',
    concepts: ['surprisal', 'entropy', 'softmax', 'unembedding'],
    inputs: [],
    endpoint: '/probe/surprisal',
    viz: 'token-heat-surprisal',
  },
  {
    id: 'unit-activation',
    intent: 'Color the text by one neuron',
    shortLabel: 'Unit over text',
    category: 'features',
    icon: Sparkle,
    concept:
      'The classic move that started neuron interpretability: pick ONE unit and read the text alongside it, colored by how strongly it fires. Famous finds from exactly this view: a quote-tracking neuron, a line-length neuron, sentiment neurons. Find a candidate with “Which neurons fire on this text” (its number goes in the Unit # field), write down your story of what it does — then test the story on a NEW text where it predicts something. Most neurons turn out boring or polysemantic; that discovery is the lesson.',
    process:
      'We ran your text, cached the MLP activations at your layer, and pulled one column: your unit’s value at every token. Warm = firing, blue = negative. Nothing is aggregated — this is the raw stream of one cell watching the text go by. If the pattern matches your hypothesis on fresh text, you have evidence; if not, you have a better lesson.',
    math: {
      expression: 'aₜ = GELU(W_in · xₜ + b)[unit]',
      note: 'One component of the MLP’s post-activation vector at each position t. The color is this single number over time — a neuron’s-eye view of the text.',
    },
    codeTemplate:
      "_, cache = model.run_with_cache(prompt)\nacts = cache['blocks.{layer}.mlp.hook_post'][0]   # [T, d_mlp]\nunit_over_text = acts[:, {head}]                   # one neuron, every token",
    concepts: ['neuron', 'mlp', 'superposition'],
    inputs: [
      { key: 'layer', label: 'Layer' },
      { key: 'head', label: 'Unit #' },
    ],
    endpoint: '/probe/unit_activation',
    viz: 'token-heat-unit',
  },
  {
    id: 'generate-trace',
    intent: 'Watch it choose, token by token',
    shortLabel: 'Generation trace',
    category: 'inspection',
    icon: Compass,
    concept:
      'Every probe so far reads the model thinking about YOUR text. This one watches it write its own — one token at a time, with the full decision visible at each step: the candidates that competed, the probability the winner had, and the entropy of the moment (how open the choice really was). High-entropy steps are where sampling temperature earns its keep; near-zero entropy means the token was forced and no temperature could change it. This is where intuitions about models “choosing” become mechanical.',
    process:
      'Sampled decoding at temperature 0.8, instrumented: before each token we recorded the model’s full next-token distribution — its entropy (uncertainty), the top candidates, and the probability of the token that won the draw. Then the token was appended and the loop continued. What you see is the exact sequence of decision moments that produced the completion.',
    math: {
      expression: 'H = −Σᵥ p(v)·log₂ p(v),   tₜ₊₁ ~ softmax(logits / T)',
      note: 'H is the entropy of the whole distribution — bits of genuine openness at this step. T is temperature: dividing logits by T flattens (T>1) or sharpens (T<1) the distribution before sampling. At H≈1 bit the choice was near-binary; at H≈12 bits, thousands of tokens were live.',
    },
    codeTemplate:
      'for step in range(n):\n    logits = model(tokens)[0, -1]\n    probs = softmax(logits)\n    entropy = -(probs * log2(probs)).sum()        # openness of this moment\n    next_id = multinomial(softmax(logits / 0.8))  # temperature sampling\n    tokens = cat([tokens, next_id])',
    concepts: ['entropy', 'surprisal', 'softmax'],
    inputs: [{ key: 'top_k', label: 'Top-k' }],
    endpoint: '/probe/generate_trace',
    viz: 'generation-trace',
  },
  {
    id: 'tokenize',
    intent: 'See what the model actually reads',
    shortLabel: 'Tokenizer inspector',
    category: 'inspection',
    icon: Books,
    concept:
      'Before any probe means anything, know what the model was actually given. Text is chopped into learned subword pieces — and the boundaries are weird in load-bearing ways: a leading space is part of the token (‘poised’ and ‘ poised’ are unrelated ids), numbers fragment (‘2026’ → ‘20’+‘26’), rare words shatter. Type a single word to get the leading-space lesson explicitly — the exact footgun that once made this workbench’s own J-lens grid look broken.',
    process:
      'Your text through the model’s tokenizer, nothing else — each chip is one token with its vocabulary id and byte count, alternating colors marking the boundaries. The · glyph shows leading spaces that are part of the token. No forward pass, no interpretation: this is the raw input layer, which is precisely why it belongs in the toolchest — every other probe’s x-axis is built from these pieces.',
    math: {
      expression: 'text → BPE merges → [id₁, id₂, …, idₙ]',
      note: 'Byte-pair encoding: start from bytes, repeatedly merge the most frequent adjacent pair seen in training text, stop at ~50k vocabulary entries. Frequency decides the units — not meaning, not grammar. That mismatch is the root of a whole family of model quirks.',
    },
    codeTemplate:
      "ids = tokenizer.encode(prompt)\npieces = [tokenizer.decode([i]) for i in ids]\n# the footgun: these are DIFFERENT tokens\ntokenizer.encode('poised')   # ['po', 'ised']\ntokenizer.encode(' poised')  # [' poised']",
    concepts: ['tokenization'],
    inputs: [],
    endpoint: '/probe/tokenize',
    viz: 'tokenizer',
  },
  {
    id: 'head-census',
    intent: 'Census every head for known jobs',
    shortLabel: 'Head census',
    category: 'inspection',
    icon: Compass,
    concept:
      'Instead of hunting heads one at a time, score all of them at once for three known signatures: previous-token heads (stare at the word before), induction heads (find the last occurrence of the current token and copy what came NEXT — the founding circuit of in-context learning), and attention sinks (park on position 0 when idle). Prompt-independent: it runs on a random repeated sequence, so it characterizes the model itself. The head the intro sent you hunting for is provable here — and on gpt2 the census rediscovers the literature’s exact heads.',
    process:
      'We built a deterministic random token sequence and repeated it — a text where the ONLY way to predict the second half is to look things up in the first half. Then one forward pass, and for every head we averaged three entries of its attention pattern: the previous-position diagonal (previous-token score), the one-period-back-plus-one diagonal (induction score — attending to what FOLLOWED the last occurrence), and column zero (sink score). High scores are structural roles, not one-prompt accidents.',
    math: {
      expression: 'induction(h) = E_i[ pattern_h(i, i − P + 1) ]',
      note: 'P is the repeat period. Position i in the second half holds token A; position i−P+1 holds what followed A last time. A head putting mass exactly there is doing [A][B]…[A]→[B] — copying the past forward. The previous-token score is the same idea on the i−1 diagonal.',
    },
    codeTemplate:
      'seq = cat([bos, rand_tokens, rand_tokens])      # repeat, period P={top_k}0\n_, cache = model.run_with_cache(seq)\np = cache["blocks.L.attn.hook_pattern"][0, head]\nprev_score = mean(p[i, i-1])\ninduction_score = mean(p[i, i-P+1])             # the lookup, one step past',
    concepts: ['induction', 'head', 'pattern'],
    inputs: [],
    endpoint: '/probe/head_census',
    viz: 'head-census',
  },
  {
    id: 'saliency',
    intent: 'Which words did it use?',
    shortLabel: 'Input saliency',
    category: 'inspection',
    icon: Target,
    concept:
      'The most natural causal question, answered with one backward pass: put a target token in the Answer box (or leave it empty to use the model’s own prediction), and every input token is colored by how strongly the target’s logit reacts to it. On “The Eiffel Tower is in the city of” → Paris, the heat lands on the Eiffel fragments, Tower, and city — not the function words. First-order evidence: for the exact answer, ablate what saliency points at.',
    process:
      'One forward pass, then one backward pass from the target token’s logit down to the input embeddings — backpropagation used as an instrument. Each token’s score is its gradient’s magnitude: how much the answer would move if that token’s representation wiggled. We tested the popular grad×input variant first and it FAILED faithfulness here (LayerNorm cancellations buried the Eiffel tokens); the plain gradient norm passed. That test is the discipline.',
    math: {
      expression: 'saliency(t) = ‖ ∂ logit(target) / ∂ eₜ ‖₂',
      note: 'eₜ is token t’s input embedding. The gradient of one scalar with respect to every input arrives in a single backward pass — the same machinery that trains the model, pointed backwards as a probe.',
    },
    codeTemplate:
      'embeds.retain_grad()\nlogits = model(tokens)[0, -1]\nlogits[target_id].backward()\nsaliency = embeds.grad[0].norm(dim=-1)   # one number per input token',
    concepts: ['gradient', 'unembedding'],
    inputs: [],
    endpoint: '/probe/saliency',
    viz: 'token-heat-saliency',
  },
  {
    id: 'weight-lens',
    intent: 'Read a neuron’s wiring, no prompt needed',
    shortLabel: 'Weight lens',
    category: 'features',
    icon: Books,
    concept:
      'Every probe so far measures activations — what happened on one prompt. This reads the WEIGHTS: what the unit is wired to do on every prompt, ever. Three columns: which token embeddings excite it (reads), and which tokens it pushes up or down when it fires (promotes / suppresses). Zero forward passes — it’s pure linear algebra on the model’s parameters. Pair it with “Color the text by one neuron”: weights say what it should do, activations say what it did.',
    process:
      'Your unit’s input weight vector was compared against every token embedding by cosine similarity (raw dot products spuriously surface glitch tokens with degenerate norms — we verified cosine fixes it), and its output weight vector was pushed through the unembedding to rank the tokens it promotes and suppresses. If the columns read as unrelated soup, that IS the finding: superposition, in the raw.',
    math: {
      expression: 'reads = cos(W_E, w_in),   promotes = w_out · W_U',
      note: 'w_in and w_out are one neuron’s columns of the MLP weight matrices. The composition W_E → w_in and w_out → W_U are the neuron’s first-order input and output “vocabularies” — what it listens for and what it says.',
    },
    codeTemplate:
      'w_in  = model.W_in[{layer}, :, {head}]     # what excites it\nw_out = model.W_out[{layer}, {head}]       # what it writes\nreads    = cosine(model.W_E, w_in).topk({top_k})\npromotes = (w_out @ model.W_U).topk({top_k})',
    concepts: ['neuron', 'mlp', 'unembedding', 'superposition'],
    inputs: [
      { key: 'layer', label: 'Layer' },
      { key: 'head', label: 'Unit #' },
      { key: 'top_k', label: 'Top-k' },
    ],
    endpoint: '/probe/weight_lens',
    viz: 'weight-lens',
  },
  {
    id: 'max-activating',
    intent: 'What makes this unit fire hardest?',
    shortLabel: 'Max-activating examples',
    category: 'features',
    icon: Binoculars,
    concept:
      '“Look at your data,” applied to neurons. The weight lens told you what a unit is wired to promote — a prior. This is the evidence: the corpus passages that actually fire it hardest, each shown as activation-colored text so you can see exactly which words lit it up. Honest scope: the built-in corpus is 40 diverse sentences — a first look, not a census. If the top passages share nothing obvious, the unit is polysemantic, and now you have receipts.',
    process:
      'We ran every sentence of the built-in corpus through the model, recorded your unit’s activation at every token of every sentence, and ranked the sentences by their peak. Each result renders as colored text with the peak token named. The workflow this completes: weight lens proposes a story → max-activating examples test it on data → unit-over-text tests it on YOUR text.',
    math: {
      expression: 'score(s) = maxₜ  a_unit(s, t)',
      note: 'For each sentence s, the unit’s largest activation across its tokens t. Ranking corpora by per-unit peaks is how the classic neuron findings (quote detectors, sentiment units) were made — and how most units are honestly revealed as uninterpretable.',
    },
    codeTemplate:
      "for sent in corpus:\n    _, cache = model.run_with_cache(sent)\n    acts = cache['blocks.{layer}.mlp.hook_post'][0][:, {head}]\n    scored.append((acts.max(), sent))\ntop = sorted(scored, reverse=True)[:{top_k}]",
    concepts: ['neuron', 'mlp', 'superposition'],
    inputs: [
      { key: 'layer', label: 'Layer' },
      { key: 'head', label: 'Unit #' },
      { key: 'top_k', label: 'Top-k' },
    ],
    endpoint: '/probe/max_activating',
    viz: 'max-activating',
  },
  {
    id: 'model-diff',
    intent: 'Same prompt, two brains',
    shortLabel: 'Model diff',
    category: 'inspection',
    icon: Swap,
    concept:
      'Run your prompt through the loaded model AND distilgpt2 (its 6-layer distilled sibling), and compare per-token surprisal side by side. The Δ column is the point: rows where the small model is shocked and the big one is calm are precisely what the extra parameters bought — and sometimes the small model wins (on our France test, distilgpt2 actually beat gpt2 at the induction game). First run downloads distilgpt2 (~350 MB, once). Same-tokenizer models only — the probe refuses apples-to-oranges diffs honestly.',
    process:
      'Both models read the identical token sequence; for each we computed per-token surprisal (the loss view) and the final next-token distribution. Rows diverging by more than 2 bits are flagged. Because both tokenizers are the gpt2 BPE, every row is a true like-for-like comparison — the probe verifies this and refuses if the tokenizations differ.',
    math: {
      expression: 'Δ(t) = −log₂ p_A(t | ctx) + log₂ p_B(t | ctx)',
      note: 'Per-token surprisal difference in bits. Negative = model A calmer. Summed over a corpus this becomes the loss gap between the models; viewed per token it shows WHERE that gap lives — grammar, facts, induction, or nowhere you expected.',
    },
    codeTemplate:
      "a = HookedTransformer.from_pretrained('gpt2')\nb = HookedTransformer.from_pretrained('distilgpt2')\nfor m in (a, b):\n    lp = m(tokens)[0].log_softmax(-1)\n    bits = [-lp[t-1, tokens[0,t]] / log(2) for t in range(1, T)]",
    concepts: ['surprisal', 'entropy', 'tokenization'],
    inputs: [{ key: 'top_k', label: 'Top-k' }],
    endpoint: '/probe/model_diff',
    viz: 'model-diff',
  },
  {
    id: 'sae-features',
    intent: 'See which learned features fire',
    shortLabel: 'SAE features',
    category: 'sae',
    icon: Books,
    concept:
      "The neuron probe showed the problem: one neuron answers to several unrelated things (superposition). A sparse autoencoder is the fix — a learned dictionary of ~24,576 features for this layer, of which only a few dozen fire at once, each (mostly) meaning one thing. This reads the strongest features at your prompt's final token, each self-labeled by the tokens it promotes. Runs on the SAE sidecar (its own service and environment), using open SAEs trained on gpt2.",
    process:
      'The sidecar encoded the residual stream at your layer through the SAE — a few dozen active features out of tens of thousands — and ranked the strongest at the final token. Each feature is labeled by pushing its decoder direction through the unembedding: the tokens it promotes. The FVU line is the built-in canary: it measures how faithfully decode(encode(x)) reconstructs the real activation, so a broken SAE announces itself instead of lying.',
    math: {
      expression: 'f = ReLU( (x − b_dec) W_enc + b_enc ),   x̂ = f W_dec + b_dec',
      note: 'x is the residual activation; W_enc expands it into the sparse feature space (ReLU keeps only positive evidence); W_dec maps active features back. Sparsity is the point: ~40 of 24,576 features are nonzero, so each carries interpretable meaning.',
    },
    codeTemplate:
      "sae = SAE.from_pretrained('gpt2-small-res-jb', 'blocks.{layer}.hook_resid_pre')\n_, cache = model.run_with_cache(prompt)\nfeats = sae.encode(cache[sae.cfg.hook_name][0])   # [token, d_sae], sparse\ntop = feats[-1].topk({top_k})                     # strongest at final token",
    concepts: ['sae', 'superposition', 'residual'],
    inputs: [
      { key: 'layer', label: 'Layer' },
      { key: 'top_k', label: 'Top-k' },
    ],
    endpoint: '/sae/features',
    viz: 'sae-feature-list',
  },
  {
    id: 'sae-ablate',
    intent: 'Knock out one learned feature',
    shortLabel: 'SAE feature ablation',
    category: 'sae',
    icon: Scissors,
    concept:
      'Head ablation removes a whole component; this removes ONE learned concept. Run “See which learned features fire” first, note a feature number, put it in the Feature # field, and knock it out: its contribution is subtracted from the residual stream at every position, everything else untouched. If the prediction moves, that single dictionary entry was causally load-bearing — causality at the resolution of individual concepts.',
    process:
      'The sidecar ran your prompt twice: clean, and with the chosen feature’s contribution (its activation times its decoder direction) subtracted from the residual stream at every token. Every other feature and the SAE’s reconstruction error stay untouched — that is what makes the knockout surgical. The two next-token lists show exactly what that one concept was contributing.',
    math: {
      expression: 'x ← x − f_i(x) · W_dec[i]',
      note: 'f_i(x) is how strongly feature i fires at each position; W_dec[i] is its direction in residual space. Subtracting the product removes exactly that feature’s contribution — a finer scalpel than zeroing a neuron or a head.',
    },
    codeTemplate:
      'def knock_out(x, hook):\n    acts = sae.encode(x)[..., {head}]            # feature strength per token\n    return x - acts.unsqueeze(-1) * sae.W_dec[{head}]\nablated = model.run_with_hooks(tokens, fwd_hooks=[(hook_name, knock_out)])',
    concepts: ['sae', 'ablation', 'residual'],
    inputs: [
      { key: 'layer', label: 'Layer' },
      { key: 'head', label: 'Feature #' },
      { key: 'top_k', label: 'Top-k' },
    ],
    endpoint: '/sae/ablate',
    viz: 'sae-ablate',
  },
];

export const PROBES_BY_CATEGORY: Record<ProbeCategory, ProbeDefinition[]> = {
  inspection: PROBES.filter((p) => p.category === 'inspection'),
  intervention: PROBES.filter((p) => p.category === 'intervention'),
  features: PROBES.filter((p) => p.category === 'features'),
  sae: PROBES.filter((p) => p.category === 'sae'),
  circuits: PROBES.filter((p) => p.category === 'circuits'),
};

export const CATEGORY_LABELS: Record<ProbeCategory, string> = {
  inspection: 'Inspect',
  intervention: 'Intervene',
  features: 'Features',
  sae: 'SAE · sidecar',
  circuits: 'Circuits',
};

export function fillTemplate(
  template: string,
  values: { layer?: number; head?: number; top_k?: number },
): string {
  return template
    .replace(/\{layer\}/g, String(values.layer ?? 0))
    .replace(/\{head\}/g, String(values.head ?? 0))
    .replace(/\{top_k\}/g, String(values.top_k ?? 10));
}
