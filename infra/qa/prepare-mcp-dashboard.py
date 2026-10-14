"""Apply only the reviewed MCP bridge to the immutable deployed dashboard source."""
import hashlib
import json
from pathlib import Path
import sys
import tarfile
archive, target = map(Path, sys.argv[1:3])
repo = Path(__file__).resolve().parents[2]
expected = 'b2bad4a7298752d85255ee3f7bc72e8e6289def84dc4090f61bd3c224b44f16b'
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected or target.exists():
    raise SystemExit('Invalid baseline or nonempty destination')
with tarfile.open(archive) as source:
    if any(not (m.isfile() or m.isdir()) for m in source.getmembers()):
        raise SystemExit('Non-regular archive entry')
    source.extractall(target, filter='data')
def hashes():
    return {str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in target.rglob('*') if p.is_file()}
before = hashes()
source_dir = repo / 'server/qa-dashboard'
entry = target / 'user-entry.mjs'
anchor = '    const needsBusiness ='
old, new = entry.read_text(), (source_dir / entry.name).read_text()
if old.count(anchor) != 1 or new.count(anchor) != 1:
    raise SystemExit('Identity boundary changed')
entry.write_text(new[:new.index(anchor)] + old[old.index(anchor):])
entry = target / 'server.mjs'
old, new = entry.read_text(), (source_dir / entry.name).read_text()
start, end = '        const result = await userEntry.handle(', '\n      }\n      if (req.method'
replacement = new[new.index(start):new.index(end,new.index(start))]
needle = '        return send(200, await userEntry.handle(req, email, url.pathname, body, url.searchParams));'
if old.count(needle) != 1:
    raise SystemExit('Response boundary changed')
entry.write_text(old.replace(needle, replacement))
entry = target / 'index.html'
old, new = entry.read_text(), (source_dir / entry.name).read_text()
start, end = '      async function qaTool(', '      function friendlyError('
helper = new[new.index(start):new.index(end,new.index(start))]
if old.count(end) != 1 or start in old:
    raise SystemExit('Browser helper boundary changed')
old = old.replace(end,helper+end)
needle = '              const result = await entryRequest(\n                "/api/me/cases/" + id + "/result",\n              );'
if old.count(needle) != 1:
    raise SystemExit('Result boundary changed')
entry.write_text(old.replace(needle,'              const result = await qaTool("qa_result", {case_id:id});'))
after = hashes()
changed = sorted(p for p in set(before)|set(after) if before.get(p)!=after.get(p))
if changed != ['index.html','server.mjs','user-entry.mjs']:
    raise SystemExit('Unexpected runtime change')
manifest = {'baseline_build_id':'3c1f4d85-a371-4638-b5a7-ab92888bdae9',
    'baseline_archive_sha256':expected,'changed_files':{p:{'before':before.get(p),'after':after[p]} for p in changed},'runtime_files':after}
(target/'mcp-overlay-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'changed':changed,'runtime_files':len(after)}))
