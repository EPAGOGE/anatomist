"""Compute the averaged Jacobian J_l per probe layer over a corpus, and cache it.

    J_l = E_{t, t'>=t, prompt}[ d h_final,t' / d h_l,t ]

Causal-attention shortcut: h_final,t' cannot depend on h_l,t for t'<t, so
    d ( sum_{all t'} h_final,t' ) / d h_l,t  ==  sum_{t'>=t} d h_final,t'/d h_l,t
i.e. one vector-Jacobian gives the future-summed Jacobian at every source t at once.
We then divide each source-t contribution by its future count (seqlen - t) to get
the mean over t'>=t, and average over source positions and prompts.
"""
from __future__ import annotations
import hashlib
import json
import os
import torch

from .model import ModelTap


# Positions before this are attention sinks with atypical residual stats; the
# final position has no next-token target. Both are excluded from the average.
# (Matches anthropics/jacobian-lens SKIP_FIRST_N_POSITIONS; reference uses 16 on
# 128-token corpora — pass a smaller value for short probe sequences.)
SKIP_FIRST_N_POSITIONS = 16
REDUCTION_VERSION = "v2-refsum-skip"  # busts cache when the estimator changes


def valid_position_mask(seq_len, skip_first=SKIP_FIRST_N_POSITIONS):
    """Bool mask [seq_len]: exclude the first `skip_first` positions and the last."""
    sk = min(skip_first, max(1, seq_len - 2))
    m = torch.zeros(seq_len, dtype=torch.bool)
    m[sk:seq_len - 1] = True
    return m


def _corpus_fingerprint(model_name, layers, corpus, skip_first):
    h = hashlib.sha1()
    h.update(model_name.encode())
    h.update(json.dumps(layers).encode())
    h.update(json.dumps(corpus).encode())
    h.update(f"{skip_first}|{REDUCTION_VERSION}".encode())
    return h.hexdigest()[:16]


def compute_jlens(tap: ModelTap, corpus: list[str], cache_dir: str = None,
                  skip_first: int = SKIP_FIRST_N_POSITIONS, dim_batch: int = 64,
                  progress=True):
    """Return {layer -> J (d x d) tensor on cpu}. Cached by (model, layers, corpus,
    skip_first, reduction). Estimator matches anthropics/jacobian-lens: one-hot
    cotangent at every VALID target position, backprop -> gradient at source p is
    sum_{p'>=p over valid targets}; mean over VALID source positions."""
    d = tap.d_model
    layers = tap.probe_layers
    accum = {l: torch.zeros(d, d, dtype=torch.float64) for l in layers}
    weight = 0.0

    cache_path = None
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        fp = _corpus_fingerprint(tap.model_name, layers, corpus, skip_first)
        cache_path = os.path.join(cache_dir, f"jlens_{fp}.pt")
        if os.path.exists(cache_path):
            blob = torch.load(cache_path)
            return {int(k): v for k, v in blob["J"].items()}

    I = torch.eye(d, device=tap.device)  # batched grad_outputs seed

    for pi, item in enumerate(corpus):
        # item is a plain string, OR a dict {text, masked_spans/spans} for a GROUNDED
        # fit (dual-stream gate 1: reasoning reads the perceived <<<OBS).
        authored = None
        if isinstance(item, dict) and hasattr(tap, "encode_grounded"):
            spans = item.get("masked_spans") or item.get("spans") or []
            input_ids, authored, _ = tap.encode_grounded(item["text"], spans)
        else:
            input_ids, _ = tap.encode(item["text"] if isinstance(item, dict) else item)
        seqlen = input_ids.shape[1]
        if seqlen < 2:
            continue
        vmask = valid_position_mask(seqlen, skip_first).to(tap.device)  # [pos] bool
        n_valid = int(vmask.sum())
        if n_valid == 0:
            continue

        resid, h_final = tap.forward_taps(input_ids, need_grad=True, authored_mask=authored)  # [1,pos,d]
        # S sums h_final over VALID TARGET positions only (attention-sink + last excluded).
        S = (h_final[0] * vmask.unsqueeze(-1)).sum(dim=0)  # [d]  (causal => future-only)

        # Batched backward from S -> grads w.r.t. EVERY probe layer at once. The full
        # [d_out, pos, d] Jacobian is O(d^2*pos) and OOMs at long seq (d=1152, pos~1k).
        # CHUNK the output dimension (like anthropics/jacobian-lens dim_batch): each chunk
        # materialises only [dim_batch, pos, d] per layer. retain_graph across chunks reuses
        # the single backward graph. Bounds memory to any seq length; fits the grounded J.
        h_list = [resid[l] for l in layers]
        nchunks = (d + dim_batch - 1) // dim_batch
        for ci in range(nchunks):
            c0, c1 = ci * dim_batch, min((ci + 1) * dim_batch, d)
            grads = torch.autograd.grad(
                outputs=S, inputs=h_list,
                grad_outputs=I[c0:c1], is_grads_batched=True,          # only these output rows
                retain_graph=(ci < nchunks - 1), create_graph=False, allow_unused=False,
            )  # tuple, one per layer: each [chunk, 1, pos, d_in]
            for l, g in zip(layers, grads):
                g = g.squeeze(1)                            # [chunk, pos, d_in]
                J_contrib = g[:, vmask, :].sum(dim=1)       # [chunk, d_in]  future-SUM/valid-src
                accum[l][c0:c1, :] += J_contrib.detach().cpu().double()  # cpu THEN f64 (MPS)
            del grads
        weight += n_valid  # number of valid source positions contributed
        # free graph
        del resid, h_final, S
        if progress and (pi + 1) % 8 == 0:
            print(f"  jlens corpus {pi+1}/{len(corpus)}", flush=True)

    J = {l: (accum[l] / weight).float() for l in layers}
    if cache_path:
        torch.save({"J": J, "model": tap.model_name, "layers": layers,
                    "corpus_size": len(corpus)}, cache_path)
    return J


def identity_lens(tap: ModelTap):
    """Logit-lens special case J_l = I: instant, and the cheap between-checkpoint
    proxy for the training observer."""
    d = tap.d_model
    return {l: torch.eye(d) for l in tap.probe_layers}
