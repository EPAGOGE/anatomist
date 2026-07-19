"""Reading with the Jacobian lens: lens(h_l)=softmax(W_U norm(J_l h_l)).

Builds the full slice-viewer payload for a prompt: per (layer, position) top-k
tokens (the argmax grid + full readouts), and helpers to track a pinned token's
rank across the (layer x position) grid — everything the Fig-5 view renders.
"""
from __future__ import annotations
import torch

from .model import ModelTap


def _clean(tok_str: str) -> str:
    return tok_str.replace("\n", "\\n").replace("\t", "\\t")


class Reader:
    def __init__(self, tap: ModelTap, J: dict[int, torch.Tensor]):
        self.tap = tap
        self.J = {l: J[l].to(tap.device) for l in J}

    def _lens_logits(self, h_l: torch.Tensor, layer: int) -> torch.Tensor:
        """h_l: [pos, d] -> vocab logits [pos, vocab]."""
        Jh = h_l @ self.J[layer].T          # apply averaged Jacobian: (J h)
        return self.tap.apply_readout(Jh)   # norm then W_U

    @torch.no_grad()
    def readout_grid(self, prompt: str, top_k: int = 6):
        """Returns the viewer payload for a prompt."""
        input_ids, toks = self.tap.encode(prompt)
        resid, _ = self.tap.forward_taps(input_ids, need_grad=False)
        seqlen = len(toks)
        layers = self.tap.probe_layers

        # grid[layer_idx][pos] = list of (token_str, prob) top_k
        grid = {}
        argmax = {}
        full_logits = {}  # (layer,pos) cached vocab logits for rank queries
        for l in layers:
            probs = torch.softmax(self._lens_logits(resid[l], l), dim=-1)  # [pos, vocab]
            full_logits[l] = probs.cpu()
            topv, topi = probs.topk(top_k, dim=-1)
            row = []
            arow = []
            for p in range(seqlen):
                cell = [( _clean(self.tap.tok.decode([topi[p, k].item()])), float(topv[p, k]))
                        for k in range(top_k)]
                row.append(cell)
                arow.append(cell[0][0])
            grid[l] = row
            argmax[l] = arow

        return {
            "prompt": prompt,
            "tokens": [_clean(t) for t in toks],
            "layers": layers,
            "layer_pct": [self.tap.layer_pct[l] for l in layers],
            "grid": {str(l): grid[l] for l in layers},      # [pos][topk] of [tok, prob]
            "argmax": {str(l): argmax[l] for l in layers},
            "_full": full_logits,  # kept out of JSON dump; used for pinned-token ranks
        }

    def pinned_rank_heatmap(self, payload, token_str: str):
        """rank (1=top) of a token across every (layer,pos) cell -> for the bottom heatmap."""
        tid = self.tap.tok.encode(token_str, add_special_tokens=False)
        if not tid:
            return None
        tid = tid[0]
        layers = payload["layers"]
        seqlen = len(payload["tokens"])
        hm = []
        for l in layers:
            probs = payload["_full"][l]  # [pos, vocab]
            ranks = (probs > probs[:, tid:tid + 1]).sum(dim=-1) + 1  # rank of tid per pos
            hm.append([int(r) for r in ranks[:seqlen].tolist()])
        return hm  # [layer][pos] rank


def dumpable(payload: dict) -> dict:
    """Strip the heavy _full tensor block for JSON serialization to the viewer."""
    return {k: v for k, v in payload.items() if not k.startswith("_")}
