"""Overlay QA MCP onto the verified gen16 source; do not deploy unrelated branch changes."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile

archive, target = map(Path, sys.argv[1:3])
repo = Path(__file__).resolve().parents[2]
expected = 'e9fd3bb69f9e8479b42bc104e72b7aed74f5136e1527d5a2167b6b7bae41990a'
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit('Baseline source archive differs from Cloud Build 641944c4-d500-43fc-b218-ac73c75f9371')
if target.exists():
    raise SystemExit('Destination must be new')
with tarfile.open(archive) as source:
    if any(not (m.isfile() or m.isdir()) for m in source.getmembers()):
        raise SystemExit('Non-regular archive entry')
    source.extractall(target, filter='data')
def hashes():
    return {str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in target.rglob('*') if p.is_file()}
before = hashes()
entry = target / 'server/bff/qa-intake-server.mjs'
text = entry.read_text()
for old, new in [
    ('// Private Cloud Run entrypoint', "import { mountQaMcpRoutes } from './qa-mcp.mjs';\n// Private Cloud Run entrypoint"),
    ('if (req.method === "POST" && !idempotencyKey)', 'if (req.method === "POST" && req.path !== "/mcp" && !idempotencyKey)'),
    ('  mountAgentCapabilityRoutes(app, { db, asyncHandler });', '  mountAgentCapabilityRoutes(app, { db, asyncHandler });\n  mountQaMcpRoutes(app, {db, asyncHandler, authorizeCase:authority, idempotencyService:createIdempotencyService(db)});'),
]:
    if text.count(old) != 1:
        raise SystemExit('Entrypoint patch context mismatch')
    text = text.replace(old, new)
entry.write_text(text)
mcp_source = (repo / 'server/bff/qa-mcp.mjs').read_bytes()
if hashlib.sha256(mcp_source).hexdigest() != '6bd9e9ffdd10032a4170933ce86db76f5fc846a1071be6e2d495b3330bc740b4':
    raise SystemExit('MCP source differs from reviewed commit 19f9363c3')
(target / 'server/bff/qa-mcp.mjs').write_bytes(mcp_source)
after = hashes()
changed = sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))
if changed != ['server/bff/qa-intake-server.mjs', 'server/bff/qa-mcp.mjs']:
    raise SystemExit('Unexpected runtime changes')
manifest = {'baseline_build_id':'641944c4-d500-43fc-b218-ac73c75f9371',
    'baseline_archive_sha256':expected, 'baseline_image_digest':'sha256:440be907b6ed6b902a196ba36e1dbdd1363d866bd15c16a598219ef9c32cc7dc',
    'changed_files':{p:{'before':before.get(p),'after':after[p]} for p in changed},
    'runtime_files':after}
(target / 'mcp-overlay-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps({'directory':str(target),'runtime_files':len(after),'changed':changed}))
