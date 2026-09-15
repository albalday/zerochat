#!/usr/bin/env python3
"""Bootstrap downloaded by the minimal ZeroChat local server.

It installs no product itself.  It copies or downloads the signed/verified
external host release, creates its private Python environment and replaces
itself with that host while preserving stdin/stdout for the control channel.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


def copy_tree(source, destination):
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination)


def download(source_url, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(source_url, timeout=30) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise RuntimeError("Downloaded bootstrap artifact is too large")
    destination.write_bytes(data)

def download_release(source_url, release):
    manifest_path = release / "release.json"
    download(source_url.rstrip("/") + "/release.json", manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), list):
        raise RuntimeError("Invalid external MCP release manifest")
    for item in manifest["files"]:
        relative = Path(str(item.get("path", "")))
        target = (release / relative).resolve()
        if not relative.parts or relative.is_absolute() or release.resolve() not in target.parents:
            raise RuntimeError("Unsafe external MCP release path")
        download(source_url.rstrip("/") + "/" + relative.as_posix(), target)
        if hashlib.sha256(target.read_bytes()).hexdigest() != item.get("sha256"):
            raise RuntimeError("External MCP release integrity check failed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    parser.add_argument("--source", choices=("local-copy", "github-pages"), required=True)
    parser.add_argument("--source-root")
    parser.add_argument("--source-url")
    options = parser.parse_args()
    home = Path(options.home).expanduser().resolve()
    release = home / "releases" / "active"
    runtime, services = release / "runtime", release / "services"
    if options.source == "local-copy":
        root = Path(options.source_root or "").resolve()
        if not (root / "runtime" / "zerochat_mcp_host.py").is_file() or not (root / "services").is_dir():
            raise RuntimeError("Local MCP source does not contain a host runtime and services")
        release.mkdir(parents=True, exist_ok=True)
        copy_tree(root / "runtime", runtime)
        copy_tree(root / "services", services)
    else:
        if not options.source_url or not options.source_url.startswith("https://"):
            raise RuntimeError("External MCP releases require an HTTPS source URL")
        release.mkdir(parents=True, exist_ok=True)
        download_release(options.source_url, release)
        if not (runtime / "zerochat_mcp_host.py").is_file() or not services.is_dir():
            raise RuntimeError("External MCP release is incomplete")
    env = home / "env"
    python = env / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(env)], check=True)
    os.execv(str(python), [str(python), str(runtime / "zerochat_mcp_host.py"), "--home", str(home), "--services-root", str(services)])


if __name__ == "__main__":
    main()
