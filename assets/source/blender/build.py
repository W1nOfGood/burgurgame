"""Builds every authored asset into apps/client/public/assets.

    python assets/source/blender/build.py            # everything (the restaurant bake is long)
    python assets/source/blender/build.py --fast     # half-res, low-sample bake for iteration
    python assets/source/blender/build.py food props # selected targets only

Needs Python 3.13 with: bpy==5.2.3 numpy scipy pillow pyoidn scikit-image (see
docs/ASSET_PIPELINE.md), plus Node + Playwright's Chromium for the .env probe conversion.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
TARGETS = ["layout", "restaurant", "env", "food", "props", "characters", "optimize"]


def run(cmd: list[str]) -> None:
    t = time.time()
    print("$", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=ROOT, check=True)
    print(f"  done in {time.time() - t:.0f}s", flush=True)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    fast = "--fast" in sys.argv
    targets = args or TARGETS
    py = sys.executable
    for t in targets:
        if t == "layout":
            run(["npx", "tsx", "--conditions=source", "scripts/export-layout.ts"])
        elif t == "restaurant":
            run([py, os.path.join(HERE, "restaurant.py")] + (["--fast"] if fast else []))
        elif t == "env":
            run(["node", "scripts/make-env.mjs"])
        elif t in ("food", "props", "characters", "optimize"):
            run([py, os.path.join(HERE, f"{t}.py")])
        else:
            raise SystemExit(f"unknown target {t}; choose from {TARGETS}")


if __name__ == "__main__":
    main()
