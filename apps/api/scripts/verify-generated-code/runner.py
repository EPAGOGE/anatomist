#!/usr/bin/env python3
"""
Forward-pass verification runner for F-0 Criterion 3.

Reads a JSON spec on stdin:
    {
      "module_path": "/tmp/.../GqaDecoderBlock.py",
      "class_name": "GqaDecoderBlock",
      "inputs": [{"param": "x", "shape": [2,16,512], "dtype": "float"}],
      "expected_output_shape": [2,16,512],
      "output_index": 0
    }

Writes a JSON result to stdout:
    {
      "status": "pass" | "fail" | "skip",
      "reason": str | None,
      "output_shape": [int, ...] | None,
      "elapsed_ms": int
    }

Exit code 0 always (the JSON status field carries pass/fail). Non-zero
only on internal harness errors (the wrapper TypeScript driver treats
non-zero as a runner bug rather than a code-under-test failure).
"""

import importlib.util
import json
import sys
import time
import traceback


def main() -> int:
    raw = sys.stdin.read()
    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"status": "fail", "reason": f"bad spec: {e}", "output_shape": None, "elapsed_ms": 0}))
        return 0

    try:
        import torch  # noqa: F401
    except ImportError:
        print(
            json.dumps(
                {
                    "status": "skip",
                    "reason": "torch not available in this Python environment",
                    "output_shape": None,
                    "elapsed_ms": 0,
                }
            )
        )
        return 0

    started = time.perf_counter()
    try:
        module_path = spec["module_path"]
        class_name = spec["class_name"]
        loader_spec = importlib.util.spec_from_file_location("epg_generated", module_path)
        if loader_spec is None or loader_spec.loader is None:
            raise RuntimeError(f"could not load module spec from {module_path}")
        module = importlib.util.module_from_spec(loader_spec)
        loader_spec.loader.exec_module(module)
        cls = getattr(module, class_name)
        model = cls()
        model.eval()

        # Build inputs.
        args = []
        for inp in spec["inputs"]:
            shape = tuple(inp["shape"])
            if inp["dtype"] == "long":
                # Small integers in [0, 100) — safe for ml.embedding which
                # defaults to vocab_size 50257 in some fixtures but the
                # caller specifies vocab_size in the fixture's properties
                # so the embed module is sized accordingly.
                args.append(torch.randint(0, 100, shape))
            else:
                args.append(torch.randn(shape))

        with torch.no_grad():
            out = model(*args)

        if isinstance(out, tuple):
            out = out[spec.get("output_index", 0)]

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        expected = tuple(spec["expected_output_shape"])
        actual = tuple(out.shape)
        if actual != expected:
            print(
                json.dumps(
                    {
                        "status": "fail",
                        "reason": f"output shape {actual} != expected {expected}",
                        "output_shape": list(actual),
                        "elapsed_ms": elapsed_ms,
                    }
                )
            )
            return 0
        print(
            json.dumps(
                {
                    "status": "pass",
                    "reason": None,
                    "output_shape": list(actual),
                    "elapsed_ms": elapsed_ms,
                }
            )
        )
        return 0
    except Exception as e:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        tb = traceback.format_exc(limit=8)
        print(
            json.dumps(
                {
                    "status": "fail",
                    "reason": f"{type(e).__name__}: {e}\n{tb}",
                    "output_shape": None,
                    "elapsed_ms": elapsed_ms,
                }
            )
        )
        return 0


if __name__ == "__main__":
    sys.exit(main())
