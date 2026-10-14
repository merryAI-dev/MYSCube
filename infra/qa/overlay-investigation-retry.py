"""Add only failed-investigation retry to an extracted, verified QA source tree."""
import hashlib
import json
from pathlib import Path
import sys
kind, destination = sys.argv[1:]
target = Path(destination)
repo = Path(__file__).resolve().parents[2]
def section(text, start, end):
    assert text.count(start) == 1
    a = text.index(start)
    return text[a:text.index(end, a)]
def replace_once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
changed = {}
def save(path, value):
    before = digest(path)
    path.write_text(value)
    changed[str(path.relative_to(target))] = {'before': before, 'after': digest(path)}
if kind == 'intake':
    path = target/'server/bff/qa-case-lifecycle.mjs'
    old = path.read_text()
    new = (repo/'server/bff/qa-case-lifecycle.mjs').read_text()
    old = replace_once(old, "z.literal('reopen'), expected_version", "z.enum(['reopen', 'retry_investigation']), expected_version")
    old = replace_once(old, 'function nextStatus(', section(new, 'function failedCurrentRun(', 'function nextStatus(')+'function nextStatus(')
    for start,end in [('function nextStatus(', '\nexport function'), ('    async read(context, caseId)', '    async transition('), ('    async transition(', '\n  };\n}')]:
        previous = section(old, start, end)
        replacement = section(new, start, end)
        if start.startswith('    async read') and 'allowed_actions' not in previous:
            replacement = replacement.replace("            ...(actor.operator && !['cancelled', 'resolved'].includes(qa.case_status) ? ['propose_assignment'] : []),\n", '')
        old = replace_once(old, previous, replacement)
    save(path, old)
elif kind == 'dashboard':
    path = target/'index.html'
    old = path.read_text()
    new = (repo/'server/qa-dashboard/index.html').read_text()
    helper = section(new, '      function renderInvestigationRetry(', '      function renderCases()')
    old = replace_once(old, '      function renderCases()', helper+'      function renderCases()')
    invocation = section(new, '              renderInvestigationRetry(lifecycleBox', '              const action =')
    old = replace_once(old, '              const action =', invocation+'              const action =')
    save(path, old)
    path = target/'user-entry.mjs'
    save(path, replace_once(path.read_text(), "['cancel', 'reopen',", "['cancel', 'reopen', 'retry_investigation',"))
else:
    raise SystemExit('Unknown package')
(target/'retry-overlay-manifest.json').write_text(json.dumps(changed,indent=2)+'\n')
print(json.dumps(changed))
