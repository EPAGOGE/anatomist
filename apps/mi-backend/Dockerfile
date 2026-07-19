# MI Workbench backend — RunPod-friendly image.
#
# Built on PyTorch 2.x CUDA. For local dev on Apple Silicon, install directly
# via pip without Docker — Docker Desktop on Mac has no GPU passthrough.
#
# Usage:
#   docker build -t mi-backend .
#   docker run --gpus all -p 8765:8765 \
#     -e HF_TOKEN=$HF_TOKEN \
#     -v $(pwd)/hf_cache:/app/hf_cache \
#     mi-backend

FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

WORKDIR /app

# System deps — minimal; most heavy lifting is in pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Python deps — split into two layers so source changes don't bust the
# expensive ML deps layer
COPY requirements.txt pyproject.toml ./
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir 'transformer-lens>=2.0' 'transformers>=4.40' 'accelerate>=0.30'

# Source
COPY mi_backend ./mi_backend
COPY main.py ./

# Cache + state mounts (RunPod will typically bind-mount volumes here)
RUN mkdir -p ./hf_cache

EXPOSE 8765

ENV MI_HOST=0.0.0.0 \
    MI_PORT=8765 \
    MI_RELOAD=false \
    MI_DEVICE=auto \
    MI_MODEL_CACHE=/app/hf_cache

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
