#!/usr/bin/env python3
"""Copy only the authority service and its pinned shared ACL dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

FILES = [
    'package.json', 'package-lock.json',
    'server/bff/firestore.mjs',
    'server/bff/cashflow-project-scope.mjs',
    'server/bff/qa-membership-owner.mjs',
    'server/bff/bff-utils.mjs',
    'server/bff/outbox.mjs',
    'server/bff/notifications.mjs',
    'server/bff/rbac-policy.mjs',
    'server/qa-authority/app.mjs',
    'server/qa-authority/service.mjs',
    'server/qa-authority/server.mjs',
    'server/qa-authority/Dockerfile',
    'server/qa-authority/cloudbuild.yaml',
]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    if output.exists():
        raise SystemExit('Output must be a new directory')
    output.mkdir(parents=True)
    manifest = {}
    for name in FILES:
        source = root / name
        if source.is_symlink() or not source.is_file():
            raise SystemExit(f'Missing regular source: {name}')
        target = output / ('Dockerfile' if name.endswith('/Dockerfile') else 'cloudbuild.yaml' if name.endswith('/cloudbuild.yaml') else name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        manifest[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    (output / 'source-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')

if __name__ == '__main__':
    main()
