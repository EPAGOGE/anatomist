"""HF model tap: exposes the residual stream at evenly-spaced layers, the final
pre-unembed residual, the final norm, and the unembedding W_U — everything the
Jacobian lens needs, arch-generically (works for Llama-family incl. SmolLM2, GPT-2).

The Jacobian lens (Gurnee, Sofroniew, Lindsey et al., "Verbalizable Representations
Form a Global Workspace in Language Models"):
    J_l = E_{t, t'>=t, prompt}[ d h_final,t' / d h_l,t ]           (d_model x d_model)
    lens(h_l) = softmax( W_U . norm( J_l h_l ) )
"""
from __future__ import annotations
import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

DEFAULT_MODEL = "HuggingFaceTB/SmolLM2-135M"


def pick_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class ModelTap:
    """Wraps an HF causal LM and taps its residual stream.

    Residual stream after decoder block i == the block's output hidden states.
    'h_final' is the last block's output (pre final-norm). The lens applies the
    model's own final norm then W_U, matching lens(h)=softmax(W_U norm(J h)).
    """

    def __init__(self, model_name: str = DEFAULT_MODEL, device: str | None = None,
                 n_layers_probe: int = 25, dtype=torch.float32):
        self.model_name = model_name
        self.device = device or pick_device()
        self.tok = AutoTokenizer.from_pretrained(model_name)
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        self.model = AutoModelForCausalLM.from_pretrained(model_name, dtype=dtype)
        self.model.to(self.device).eval()

        self.blocks = self._locate_blocks()
        self.final_norm = self._locate_final_norm()
        self.W_U = self._locate_unembed()  # [vocab, d_model]
        self.n_blocks = len(self.blocks)
        self.d_model = self.W_U.shape[1]
        self.vocab = self.W_U.shape[0]

        # 25 evenly spaced probe layers over [0, n_blocks-1], indexable as %.
        idx = np.round(np.linspace(0, self.n_blocks - 1, min(n_layers_probe, self.n_blocks)))
        self.probe_layers = sorted(set(int(i) for i in idx))
        self.layer_pct = {l: round(100 * l / (self.n_blocks - 1)) for l in self.probe_layers}

    # ---- architecture location (Llama-family + GPT-2) ----
    def _locate_blocks(self):
        m = self.model
        for path in ("model.layers", "transformer.h", "gpt_neox.layers", "model.decoder.layers"):
            obj = m
            try:
                for p in path.split("."):
                    obj = getattr(obj, p)
                return list(obj)
            except AttributeError:
                continue
        raise RuntimeError("could not locate decoder blocks for this architecture")

    def _locate_final_norm(self):
        m = self.model
        for path in ("model.norm", "transformer.ln_f", "gpt_neox.final_layer_norm", "model.decoder.final_layer_norm"):
            obj = m
            try:
                for p in path.split("."):
                    obj = getattr(obj, p)
                return obj
            except AttributeError:
                continue
        raise RuntimeError("could not locate final norm")

    def _locate_unembed(self):
        # tied or untied lm_head
        lm = getattr(self.model, "lm_head", None)
        if lm is not None and hasattr(lm, "weight"):
            return lm.weight.detach()
        emb = self.model.get_output_embeddings()
        return emb.weight.detach()

    def encode(self, text: str):
        ids = self.tok(text, return_tensors="pt").input_ids.to(self.device)
        toks = [self.tok.decode([i]) for i in ids[0].tolist()]
        return ids, toks

    @staticmethod
    def _block_out(out):
        return out[0] if isinstance(out, tuple) else out

    def forward_taps(self, input_ids, need_grad: bool, authored_mask=None):
        """Run one forward, capturing residual-stream tensors at probe layers and
        h_final. `authored_mask` is accepted for a uniform tap interface but IGNORED
        here — HF models are single-stream (only GameFormerTap's dual stream uses it).
        When need_grad, returns the FULL [1,pos,d] block-output tensors (the exact
        nodes on the autograd path — a [0] view would branch off the graph and read
        as 'not used'); else returns squeezed [pos,d] tensors for readout."""
        captured: dict[int, torch.Tensor] = {}
        handles = []

        def mk_hook(layer_idx):
            def hook(_m, _inp, out):
                captured[layer_idx] = self._block_out(out)  # [1, pos, d], on the graph
            return hook

        want = set(self.probe_layers) | {self.n_blocks - 1}
        for li in want:
            handles.append(self.blocks[li].register_forward_hook(mk_hook(li)))

        ctx = torch.enable_grad() if need_grad else torch.no_grad()
        with ctx:
            self.model(input_ids=input_ids)
        for h in handles:
            h.remove()

        if need_grad:
            h_final = captured[self.n_blocks - 1]           # [1, pos, d]
            resid = {l: captured[l] for l in self.probe_layers}
        else:
            h_final = captured[self.n_blocks - 1][0]        # [pos, d]
            resid = {l: captured[l][0] for l in self.probe_layers}
        return resid, h_final

    def apply_readout(self, vec: torch.Tensor) -> torch.Tensor:
        """norm then unembed -> vocab logits. vec: [..., d]."""
        with torch.no_grad():
            normed = self.final_norm(vec)
            return normed @ self.W_U.T
