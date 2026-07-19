"""Model library catalog — what's loadable and what tools work against each.

This is the canonical source for Subsystem 1 (Model Library + Loading) per
docs/MI_Workbench.md. The frontend's "Load Model" UI consumes this directly.

V1: hand-curated catalog of the 6-8 models we'll support first. Future
versions detect tool availability programmatically (TransformerLens compat
check via attempted load, Gemma Scope check via HF API, etc.).
"""

from __future__ import annotations

from pydantic import BaseModel


class ToolAvailability(BaseModel):
    """Per-model availability of MI tools."""

    transformer_lens: bool = False
    gemma_scope: bool = False
    nla_anthropic: bool = False
    custom_saes: bool = False


class ModelEntry(BaseModel):
    """A single entry in the model library catalog."""

    id: str
    """HF model id (or short alias used by TransformerLens)."""

    display_name: str
    family: str
    """Architectural family — informs the 3D scene layout."""

    params_b: float
    """Parameter count in billions (for 'can this run locally' detection)."""

    license: str
    gated: bool
    """If True, requires HF_TOKEN with accepted license to download."""

    tools: ToolAvailability
    notes: str = ""


# Canonical catalog. Add new models here as V2/V3 lands.
CATALOG: list[ModelEntry] = [
    ModelEntry(
        id="gemma-2-2b-it",
        display_name="Gemma 2 (2B, instruction-tuned)",
        family="gemma2",
        params_b=2.6,
        license="gemma-license",
        gated=True,
        tools=ToolAvailability(transformer_lens=True, gemma_scope=True),
        notes="V1 default. Smallest model with Gemma Scope SAEs available.",
    ),
    ModelEntry(
        id="gemma-2-9b-it",
        display_name="Gemma 2 (9B, instruction-tuned)",
        family="gemma2",
        params_b=9.2,
        license="gemma-license",
        gated=True,
        tools=ToolAvailability(transformer_lens=True, gemma_scope=True),
        notes="Needs cloud runtime on most laptops.",
    ),
    ModelEntry(
        id="gemma-2-27b-it",
        display_name="Gemma 2 (27B, instruction-tuned)",
        family="gemma2",
        params_b=27.2,
        license="gemma-license",
        gated=True,
        tools=ToolAvailability(transformer_lens=True, gemma_scope=True),
        notes="Cloud only — 80 GB GPU recommended.",
    ),
    ModelEntry(
        id="gpt2",
        display_name="GPT-2 small (124M)",
        family="gpt2",
        params_b=0.124,
        license="mit",
        gated=False,
        tools=ToolAvailability(transformer_lens=True, custom_saes=True),
        notes="Tiny, fast — classic MI testbed.",
    ),
    ModelEntry(
        id="pythia-1b",
        display_name="Pythia 1B",
        family="pythia",
        params_b=1.0,
        license="apache-2.0",
        gated=False,
        tools=ToolAvailability(transformer_lens=True, custom_saes=True),
        notes="EleutherAI; commonly used for circuit-finding exercises.",
    ),
    ModelEntry(
        id="meta-llama/Llama-3.2-1B-Instruct",
        display_name="Llama 3.2 (1B, instruction-tuned)",
        family="llama3",
        params_b=1.2,
        license="llama-3-license",
        gated=True,
        tools=ToolAvailability(transformer_lens=True),
    ),
    ModelEntry(
        id="meta-llama/Llama-3.2-3B-Instruct",
        display_name="Llama 3.2 (3B, instruction-tuned)",
        family="llama3",
        params_b=3.2,
        license="llama-3-license",
        gated=True,
        tools=ToolAvailability(transformer_lens=True),
    ),
]
# NOTE: optional extensions may append to CATALOG at import time (see
# gameformer_ext.model.register — deleting that folder leaves this list
# exactly as written here).


def get_by_id(model_id: str) -> ModelEntry | None:
    for entry in CATALOG:
        if entry.id == model_id:
            return entry
    return None


def fits_locally(entry: ModelEntry, available_ram_gb: float) -> bool:
    """Empirical estimate for the TransformerBridge compat-mode load path.

    Measured, not theoretical: gemma-2-2b (2.6B params) OOM'd at ~20 GB on a
    16 GB machine because compat mode converts weights in fp32 while holding
    TWO copies (~8 bytes/param transient peak), regardless of the requested
    dtype. So: params_b * 8 GB peak + 2 GB overhead. gpt2 (0.124B) needs ~3 GB.
    """
    return entry.params_b * 8.0 + 2.0 < available_ram_gb
