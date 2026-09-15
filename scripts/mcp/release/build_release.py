#!/usr/bin/env python3
"""Build an immutable, hash-described external MCP release for publication."""
from __future__ import annotations
import argparse, hashlib, json, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--release-id', default='dev')
    args = parser.parse_args()
    out = Path(args.output).resolve()
    if out.exists(): shutil.rmtree(out)
    out.mkdir(parents=True)
    for name in ('bootstrap', 'runtime', 'services'):
        shutil.copytree(ROOT / name, out / name, ignore=shutil.ignore_patterns('__pycache__'))
    files = []
    for path in sorted(p for p in out.rglob('*') if p.is_file()):
        files.append({'path': path.relative_to(out).as_posix(), 'sha256': digest(path), 'size': path.stat().st_size})
    (out / 'release.json').write_text(json.dumps({'schemaVersion': 1, 'releaseId': args.release_id, 'files': files}, indent=2) + '\n', encoding='utf-8')

if __name__ == '__main__': main()
