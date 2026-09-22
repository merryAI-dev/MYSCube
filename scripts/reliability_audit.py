"""Read-only, snapshot-consistent inventory of retained client error events."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse
import urllib.request


FIELDS = ['createdAt', 'occurredAt', 'source', 'name', 'slackStatus',
          'href', 'clientRequestId', 'environment', 'release']
SOURCES = {'platform_api', 'error_boundary', 'portal_store', 'portal_weekly_expense',
           'window_error', 'unhandled_rejection', 'ops_slack_probe', 'application'}
NAMES = {'TimeoutError', 'PlatformApiError', 'TypeError', 'AbortError', 'FirebaseError',
         'ReferenceError', 'GoogleDriveBrowserUploadError', 'Error', 'NotFoundError'}
KST = dt.timezone(dt.timedelta(hours=9))


def decode(value):
    if 'mapValue' in value:
        return {k: decode(v) for k, v in value['mapValue'].get('fields', {}).items()}
    if 'arrayValue' in value:
        return [decode(v) for v in value['arrayValue'].get('values', [])]
    if 'nullValue' in value:
        return None
    if 'integerValue' in value:
        return int(value['integerValue'])
    return next(iter(value.values()), None)


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(dt.timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def environment(record, production_hosts):
    try:
        host = (urllib.parse.urlsplit(record.get('href') or '').hostname or '').lower()
    except (ValueError, TypeError):
        host = ''
    declared = record.get('environment')
    if declared in ('production', 'preview', 'development'):
        return f'client_declared_{declared}'
    if host in production_hosts:
        return 'production_host_observed'
    if host in ('localhost', '127.0.0.1', '::1'):
        return 'local_host_observed'
    # A vercel.app address can be a production alias; it is not proof of preview.
    return 'unknown'


def fresh_state(project, tenant, hosts, read_time):
    return dict(version=1, project=project, tenant=tenant, productionHosts=sorted(hosts),
                readTime=read_time, cursor=None, pages=0, total=0, firstUtc=None,
                lastUtc=None, missingCreatedAt=0, missingOccurredAt=0, dailyKst={},
                environments={}, sources={}, names={}, slackStatuses={},
                releasePresent=0, requestIdPresent=0, requestGroups={}, exhausted=False)


def increment(mapping, key):
    mapping[key] = mapping.get(key, 0) + 1


def consume(state, documents):
    for doc in documents:
        name = doc['name']
        if state['cursor'] and name <= state['cursor']:
            raise ValueError('Non-increasing cursor; refusing an overlapping page')
        state['cursor'] = name
        row = {key: decode(value) for key, value in doc.get('fields', {}).items()}
        state['total'] += 1
        created = timestamp(row.get('createdAt'))
        if created:
            iso = created.isoformat()
            state['firstUtc'] = min(state['firstUtc'] or iso, iso)
            state['lastUtc'] = max(state['lastUtc'] or iso, iso)
            increment(state['dailyKst'], created.astimezone(KST).date().isoformat())
        else:
            state['missingCreatedAt'] += 1
        if not timestamp(row.get('occurredAt')):
            state['missingOccurredAt'] += 1
        increment(state['environments'], environment(row, state['productionHosts']))
        increment(state['sources'], row.get('source') if row.get('source') in SOURCES else 'other_or_missing')
        increment(state['names'], row.get('name') if row.get('name') in NAMES else 'other_or_missing')
        status = row.get('slackStatus')
        increment(state['slackStatuses'], status if status in ('sent', 'skipped', 'pending', 'failed', 'disabled') else 'other_or_missing')
        if row.get('release'):
            state['releasePresent'] += 1
        request = row.get('clientRequestId')
        if isinstance(request, str) and request:
            state['requestIdPresent'] += 1
            key = hashlib.sha256(json.dumps([request, row.get('source'), row.get('name')]).encode()).hexdigest()
            increment(state['requestGroups'], key)


def report(state, expected_count):
    counts = state['requestGroups'].values()
    reconciled = expected_count is not None and expected_count == state['total']
    return {
        **{key: value for key, value in state.items() if key not in ('cursor', 'requestGroups', 'exhausted')},
        'status': 'complete' if state['exhausted'] and reconciled else 'partial',
        'snapshotCount': expected_count,
        'countReconciled': reconciled,
        'repeatedRequestGroups': sum(n > 1 for n in counts),
        'repeatedRequestExtraEvents': sum(n - 1 for n in counts if n > 1),
        'errorRate': None,
        'denominatorStatus': 'unavailable_in_error_only_collection',
        'limitations': [
            'Counts are retained raw events, not unique incidents or verified production failures.',
            'Environment comes from untrusted client metadata and is not server-attested.',
            'Repeated request groups are candidates only; no events were subtracted.',
            'Missing days do not establish zero errors or healthy collection.',
            'A snapshot covers retained records, not deleted or never-collected history.',
        ],
    }


def write_private(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write('\n')
    os.chmod(temp, 0o600)
    temp.replace(path)


def audit(args):
    hosts = sorted({host.lower() for host in args.production_host})
    if args.resume:
        state = json.loads(Path(args.checkpoint).read_text())
        if (state.get('version'), state.get('project'), state.get('tenant'), state.get('productionHosts')) != (1, args.project, args.tenant, hosts):
            raise ValueError('Checkpoint scope differs; use a new checkpoint')
    else:
        state = fresh_state(args.project, args.tenant, hosts,
                            dt.datetime.now(dt.timezone.utc).isoformat(timespec='microseconds'))
    parent = f'projects/{args.project}/databases/(default)/documents/orgs/{args.tenant}'

    def call(method, query):
        request = urllib.request.Request(
            f'https://firestore.googleapis.com/v1/{parent}:{method}',
            data=json.dumps({**query, 'readTime': state['readTime']}).encode(),
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.load(response)

    try:
        token = subprocess.run(['gcloud', 'auth', 'print-access-token'], capture_output=True, text=True, check=True).stdout.strip()
        while not state['exhausted']:
            query = {'from': [{'collectionId': 'client_error_events'}],
                     'select': {'fields': [{'fieldPath': field} for field in FIELDS]},
                     'orderBy': [{'field': {'fieldPath': '__name__'}, 'direction': 'ASCENDING'}],
                     'limit': args.page_size}
            if state['cursor']:
                query['startAt'] = {'values': [{'referenceValue': state['cursor']}], 'before': False}
            rows = call('runQuery', {'structuredQuery': query})
            documents = [row['document'] for row in rows if 'document' in row]
            # Commit only a fully validated page; failed pages can be resumed safely.
            candidate = json.loads(json.dumps(state))
            consume(candidate, documents)
            candidate['pages'] += 1
            candidate['exhausted'] = len(documents) < args.page_size
            state = candidate
            write_private(args.checkpoint, state)
        counted = call('runAggregationQuery', {'structuredAggregationQuery': {
            'structuredQuery': {'from': [{'collectionId': 'client_error_events'}]},
            'aggregations': [{'alias': 'total', 'count': {}}]}})
        expected = next(decode(row['result']['aggregateFields']['total']) for row in counted if 'result' in row)
        result = report(state, expected)
        write_private(args.output, result)
        print(json.dumps({key: result[key] for key in ('status', 'readTime', 'total', 'pages', 'snapshotCount', 'countReconciled')}))
        return 0 if result['status'] == 'complete' else 2
    except Exception as error:
        result = report(state, None)
        result['failureType'] = type(error).__name__
        if hasattr(error, 'code'):
            result['httpStatus'] = error.code
        write_private(args.output, result)
        # Do not print HTTP response bodies, tokens, or original records.
        print(f'Audit incomplete: {type(error).__name__}; see aggregate report. Resume retains the same readTime.', file=sys.stderr)
        return 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--tenant', required=True)
    parser.add_argument('--production-host', action='append', default=[])
    parser.add_argument('--page-size', type=int, default=500)
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.page_size <= 500:
        parser.error('page-size must be between 1 and 500')
    if not all(re.fullmatch(r'[a-zA-Z0-9_-]+', value) for value in (args.project, args.tenant)):
        parser.error('project and tenant must be path segments')
    if Path(args.checkpoint).resolve() == Path(args.output).resolve():
        parser.error('checkpoint and output must be different files')
    try:
        return audit(args)
    except Exception as error:
        write_private(args.output, {'status': 'unavailable', 'failureType': type(error).__name__,
                                    'project': args.project, 'tenant': args.tenant,
                                    'errorRate': None, 'countReconciled': False})
        print(f'Audit unavailable: {type(error).__name__}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
