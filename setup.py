from __future__ import annotations

import shutil
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py as BuildPy


ROOT = Path(__file__).parent.resolve()
ASSET_FILES = ("zerochat.html", "manifest.webmanifest", "sw.js")
ASSET_DIRECTORIES = ("js", "css", "help", "services")
EXCLUDED_PARTS = {"node_modules", ".playwright-mcp", "__pycache__"}
EXCLUDED_NAMES = {".installed.json", "package.json", "package-lock.json", "memory.jsonl"}


def ignore_runtime_files(directory: str, names: list[str]) -> set[str]:
    ignored = set()
    for name in names:
        if name in EXCLUDED_PARTS or name in EXCLUDED_NAMES or name.startswith("."):
            ignored.add(name)
    return ignored


class ZeroChatBuildPy(BuildPy):
    """Copia los recursos web junto al módulo sin duplicarlos en el repositorio."""

    def run(self):
        super().run()
        assets = Path(self.build_lib) / "zerochat_runtime" / "assets"
        assets.mkdir(parents=True, exist_ok=True)
        for filename in ASSET_FILES:
            source = ROOT / filename
            if source.is_file():
                shutil.copy2(source, assets / filename)
        for dirname in ASSET_DIRECTORIES:
            source = ROOT / dirname
            if source.is_dir():
                shutil.copytree(source, assets / dirname, dirs_exist_ok=True, ignore=ignore_runtime_files)


setup(cmdclass={"build_py": ZeroChatBuildPy})
