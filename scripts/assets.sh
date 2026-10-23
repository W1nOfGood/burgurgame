#!/bin/sh
# Rebuilds the authored art (see docs/ASSET_PIPELINE.md). Set ASSET_PYTHON to a Python 3.13
# interpreter that has bpy 5.2.3 and the other asset dependencies installed.
set -e
cd "$(dirname "$0")/.."
exec "${ASSET_PYTHON:-python3.13}" assets/source/blender/build.py "$@"
