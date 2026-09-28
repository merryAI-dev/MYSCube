import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request

SPEC = importlib.util.spec_from_file_location('fetch_host_bundle', Path(__file__).with_name('fetch-host-bundle.py'))
fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch)
SHA, TOKEN = 'a' * 40, 'canary-token-never-log'
sha256 = lambda value: hashlib.sha256(value).hexdigest()


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None, on_read=None):
        super().__init__(body)
        self.status, self.headers, self.on_read = status, headers or {}, on_read
        self.read_sizes = []

    def read1(self, count):
        self.read_sizes.append(count)
        if self.on_read:
            self.on_read()
        return self.read(count)


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.parent = Path(self.temp.name).resolve()
        self.directory = self.parent / 'bundle'
        self.bodies = {'app.docker.tar': b'a' * (fetch.CHUNK + 19), 'renderer.docker.tar': b'synthetic renderer'}
        self.manifest = {
            'schemaVersion': 1, 'format': 'docker-save', 'sourceSha': SHA, 'classification': 'production_candidate',
            'platform': {'os': 'linux', 'architecture': 'amd64'},
            'requirements': {'nodeMajor': 24, 'libc': 'glibc', 'minimumGlibc': '2.36', 'docker': 'local-linux'},
            'build': {'nodeVersion': 'v24.12.0', 'auth': {'projectId': 'approved-fixture', 'domain': 'auth.example.org', 'apiKeySha256': '1' * 64},
                      'locks': {'root': '2' * 64, 'workbench': '3' * 64}},
            'images': [{'role': role, 'tag': tag, 'id': 'sha256:' + str(i) * 64, 'archive': name,
                        'bytes': len(self.bodies[name]), 'sha256': sha256(self.bodies[name])}
                       for i, (role, (tag, name)) in enumerate(fetch.FILES.items(), 1)]}
        self.calls, self.responses = [], []
        self.response_override = None
        self.opener = mock.Mock(open=self.open)

    def tearDown(self):
        self.temp.cleanup()

    def raw(self):
        return json.dumps(self.manifest).encode()

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        index = len(self.calls) - 1
        body = self.raw() if index == 0 else self.bodies[self.manifest['images'][index - 1]['archive']]
        response = self.response_override(index, body) if self.response_override else Response(body)
        self.responses.append(response)
        return response

    def run_fetch(self, **kwargs):
        options = {'source': SHA, 'manifest_sha': sha256(self.raw()), 'directory': str(self.directory),
                   'token': TOKEN, 'opener': self.opener, 'uid': os.geteuid()}
        options.update(kwargs)
        return fetch.fetch_bundle(**options)

    def test_streamed_pinned_fixed_gets_and_private_exclusive_files(self):
        result = self.run_fetch()
        self.assertEqual(result, {'downloaded': True, 'sourceSha': SHA, 'manifestSha256': sha256(self.raw()), 'files': 3, 'requiresReleaseVerification': True})
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        for (request, timeout), name in zip(self.calls, ['manifest.json', 'app.docker.tar', 'renderer.docker.tar']):
            self.assertEqual(request.full_url, f'https://storage.googleapis.com/storage/v1/b/myscube-axr-releases-20260924/o/releases%2F{SHA}%2F{name}?alt=media')
            self.assertEqual(request.get_method(), 'GET')
            self.assertEqual(request.get_header('Authorization'), 'Bearer ' + TOKEN)
            self.assertEqual(request.get_header('Accept-encoding'), 'identity')
            self.assertEqual(timeout, 30)
            self.assertEqual(stat.S_IMODE((self.directory / name).stat().st_mode), 0o600)
            self.assertEqual((self.directory / name).read_bytes(), self.raw() if name == 'manifest.json' else self.bodies[name])
        self.assertGreater(len(self.responses[1].read_sizes), 2)
        self.assertTrue(all(0 < size <= fetch.CHUNK for response in self.responses for size in response.read_sizes))
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_token_is_exact_bounded_single_line(self):
        self.assertEqual(fetch.read_token(io.BytesIO((TOKEN + '\n').encode())), TOKEN)
        self.assertEqual(len(fetch.read_token(io.BytesIO(b'a' * 8192 + b'\n'))), 8192)
        for raw in [b'', b'a', b'a\r\n', b'a\nb\n', b'a\n\n', b'a' * 8193 + b'\n', b'a b\n', b'\xff\n', b'\n']:
            with self.subTest(raw=raw[:10]), self.assertRaises((ValueError, UnicodeError)):
                fetch.read_token(io.BytesIO(raw))

    def test_invalid_pins_and_path_reject_without_requests(self):
        for kwargs in [{'source': '../escape'}, {'source': 'A' * 40}, {'manifest_sha': 'x' * 64},
                       {'directory': 'relative'}, {'directory': str(self.parent / '..' / 'escape')},
                       {'directory': str(self.directory) + '\n'}, {'token': 'x\r\nInjected: yes'}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.run_fetch(**kwargs)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.directory.exists())

    def test_existing_directory_is_never_overwritten(self):
        self.directory.mkdir()
        (self.directory / 'unrelated').write_bytes(b'preserved')
        with self.assertRaises(FileExistsError):
            self.run_fetch()
        self.assertEqual((self.directory / 'unrelated').read_bytes(), b'preserved')
        self.assertEqual(self.calls, [])

    def test_symlink_output_or_parent_and_writable_parent_rejected(self):
        self.directory.symlink_to(self.parent, target_is_directory=True)
        with self.assertRaises(FileExistsError):
            self.run_fetch()
        self.directory.unlink()
        alias = self.parent / 'alias'
        alias.symlink_to(self.parent, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.run_fetch(directory=str(alias / 'bundle'))
        os.chmod(self.parent, 0o770)
        with self.assertRaises(ValueError):
            self.run_fetch()
        self.assertEqual(self.calls, [])

    def test_wrong_owner_rejected_before_mkdir(self):
        with self.assertRaises(ValueError):
            self.run_fetch(uid=os.geteuid() + 1)
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.calls, [])

    def test_manifest_pin_checked_before_archive_or_schema_use(self):
        with self.assertRaises(ValueError):
            self.run_fetch(manifest_sha='0' * 64)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(list(self.directory.iterdir()), [self.directory / 'manifest.json'])

    def test_manifest_contract_rejects_wrong_source_class_platform_roles_paths_sizes_and_unknown_fields(self):
        mutations = [lambda m: m.update(sourceSha='b' * 40), lambda m: m.update(classification='synthetic'),
                     lambda m: m['platform'].update(architecture='arm64'), lambda m: m.update(extra=1),
                     lambda m: m.update(schemaVersion=True), lambda m: m['images'].pop(),
                     lambda m: m['images'].append(copy.deepcopy(m['images'][0])),
                     lambda m: m['images'][1].update(role='app'), lambda m: m['images'][1].update(id=m['images'][0]['id']),
                     lambda m: m['images'][0].update(archive='../escape'), lambda m: m['images'][0].update(tag='mutable:latest'),
                     lambda m: m['images'][0].update(bytes=True), lambda m: m['images'][0].update(bytes=fetch.ARCHIVE_LIMIT + 1),
                     lambda m: m['images'][0].update(bytes=0), lambda m: m['images'][0].update(sha256='x' * 64),
                     lambda m: m['build']['locks'].update(extra='x'), lambda m: m['images'][0].update(url='https://evil.invalid')]
        original = copy.deepcopy(self.manifest)
        for mutate in mutations:
            self.manifest = copy.deepcopy(original)
            mutate(self.manifest)
            with self.subTest(manifest=self.manifest), self.assertRaises(ValueError):
                fetch.validate_manifest(self.raw(), SHA)

    def test_duplicate_json_key_and_invalid_json_constants_rejected(self):
        for raw in [self.raw().replace(b'"schemaVersion": 1', b'"schemaVersion": 1, "schemaVersion": 1'),
                    self.raw().replace(b'"schemaVersion": 1', b'"schemaVersion": NaN'), b'\xff']:
            with self.assertRaises((ValueError, UnicodeError)):
                fetch.validate_manifest(raw, SHA)

    def test_all_http_redirect_codes_have_no_followup_request(self):
        for code in (301, 302, 303, 307, 308):
            request = urllib.request.Request('https://storage.googleapis.com/', headers={'Authorization': 'Bearer ' + TOKEN})
            handler = fetch.NoRedirect()
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, '^bundle_redirect_forbidden$'):
                getattr(handler, 'http_error_' + str(code))(request, io.BytesIO(), code, 'redirect', {'location': 'https://evil.invalid/'})

    def test_default_opener_ignores_environment_proxies(self):
        with mock.patch.dict(os.environ, {'https_proxy': 'https://evil.invalid'}), mock.patch.object(fetch.urllib.request, 'build_opener', return_value=self.opener) as build:
            self.run_fetch(opener=None)
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsInstance(build.call_args.args[1], fetch.NoRedirect)

    def test_status_encoding_and_content_length_rejected_before_file(self):
        cases = [(206, {}), (401, {}), (403, {}), (302, {}), (200, {'Content-Encoding': 'gzip'}),
                 (200, {'Content-Length': str(fetch.MANIFEST_LIMIT + 1)}), (200, {'Content-Length': '-1'})]
        for index, (status, headers) in enumerate(cases):
            self.calls = []
            self.response_override = lambda _, body: Response(body, status, headers)
            directory = self.parent / ('bad' + str(index))
            with self.subTest(status=status, headers=headers), self.assertRaises(ValueError):
                self.run_fetch(directory=str(directory))
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(list(directory.iterdir()), [])

    def test_archive_early_eof_oversize_hash_and_length_mismatch(self):
        original = self.bodies['app.docker.tar']
        for index, body in enumerate([original[:-1], original + b'x', b'x' * len(original)]):
            self.calls = []
            self.bodies['app.docker.tar'] = body
            with self.subTest(index=index), self.assertRaises(ValueError):
                self.run_fetch(directory=str(self.parent / ('size' + str(index))))
            self.assertEqual(len(self.calls), 2)
        self.calls = []
        self.bodies['app.docker.tar'] = original
        self.response_override = lambda index, body: Response(body, headers={'Content-Length': '1'} if index == 1 else {})
        with self.assertRaises(ValueError):
            self.run_fetch()
        self.assertFalse((self.directory / 'app.docker.tar').exists())

    def test_manifest_actual_bytes_cannot_exceed_absolute_cap(self):
        self.response_override = lambda _, body: Response(body + b' ' * fetch.MANIFEST_LIMIT)
        with self.assertRaises(ValueError):
            self.run_fetch()
        self.assertEqual(len(self.calls), 1)
        self.assertLessEqual((self.directory / 'manifest.json').stat().st_size, fetch.MANIFEST_LIMIT)

    def test_total_timeout_checks_after_blocking_read(self):
        clock = [0]
        self.response_override = lambda _, body: Response(body, on_read=lambda: clock.__setitem__(0, 901))
        with mock.patch.object(fetch.time, 'monotonic', side_effect=lambda: clock[0]), self.assertRaises(ValueError):
            self.run_fetch()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual((self.directory / 'manifest.json').stat().st_size, 0)

    def test_network_failure_safe_cli_error_never_echoes_token_or_body(self):
        stdin = mock.Mock(buffer=io.BytesIO((TOKEN + '\n').encode()))
        for error in [urllib.error.HTTPError('https://storage.googleapis.com/', 401, TOKEN, {}, None),
                      OSError(TOKEN), TimeoutError(TOKEN)]:
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.object(fetch.sys, 'argv', ['fetch-host-bundle.py', '--source-sha', SHA, '--manifest-sha256', sha256(self.raw()), '--directory', str(self.directory)]), \
                 mock.patch.object(fetch.sys, 'stdin', stdin), mock.patch.object(fetch, 'fetch_bundle', side_effect=error), \
                 contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                stdin.buffer.seek(0)
                self.assertEqual(fetch.main(), 1)
            self.assertEqual(out.getvalue(), '')
            self.assertEqual(err.getvalue(), 'Bundle fetch failed. Do not use the incomplete directory; release verification is required.\n')
            self.assertNotIn(TOKEN, err.getvalue())

    def test_partial_network_failure_has_no_renderer_request_or_success(self):
        reads = [0]
        def fail():
            reads[0] += 1
            if reads[0] == 2:
                raise OSError(TOKEN)
        self.response_override = lambda index, body: Response(body, on_read=fail if index == 1 else None)
        with self.assertRaises(OSError):
            self.run_fetch()
        self.assertEqual(len(self.calls), 2)
        self.assertFalse((self.directory / 'renderer.docker.tar').exists())
        self.assertEqual((self.directory / 'app.docker.tar').stat().st_size, fetch.CHUNK)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)

    def test_cli_uses_actual_login_user_ownership_not_assumed_root(self):
        stdin = mock.Mock(buffer=io.BytesIO((TOKEN + '\n').encode()))
        with mock.patch.object(fetch.sys, 'argv', ['fetch-host-bundle.py', '--source-sha', SHA, '--manifest-sha256', sha256(self.raw()), '--directory', str(self.directory)]), \
             mock.patch.object(fetch.sys, 'stdin', stdin), mock.patch.object(fetch.os, 'geteuid', return_value=12345), \
             mock.patch.object(fetch, 'fetch_bundle', return_value={'downloaded': True}) as download, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(fetch.main(), 0)
        self.assertEqual(download.call_args.kwargs, {'uid': 12345})
        self.assertEqual(download.call_args.args[-1], TOKEN)

    def test_file_replacement_during_read_is_rejected(self):
        replaced = [False]
        def substitute():
            if not replaced[0]:
                replaced[0] = True
                path = self.directory / 'app.docker.tar'
                path.rename(self.directory / 'detached')
                path.write_bytes(b'replacement')
        self.response_override = lambda index, body: Response(body, on_read=substitute if index == 1 else None)
        with self.assertRaises(ValueError):
            self.run_fetch()
        self.assertTrue(replaced[0])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual((self.directory / 'app.docker.tar').read_bytes(), b'replacement')

    def test_directory_replacement_before_completion_is_rejected(self):
        replaced = [False]
        def substitute():
            if not replaced[0]:
                replaced[0] = True
                self.directory.rename(self.parent / 'detached')
                self.directory.mkdir()
        self.response_override = lambda index, body: Response(body, on_read=substitute if index == 2 else None)
        with self.assertRaises(ValueError):
            self.run_fetch()
        self.assertTrue(replaced[0])
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assertTrue((self.parent / 'detached' / 'renderer.docker.tar').exists())

    def test_exclusive_file_creation_blocks_injected_hardlink(self):
        outside = self.parent / 'unrelated'
        outside.write_bytes(b'preserved')
        def inject(index, body):
            if index == 1:
                os.link(outside, self.directory / 'app.docker.tar')
            return Response(body)
        self.response_override = inject
        with self.assertRaises(FileExistsError):
            self.run_fetch()
        self.assertEqual(outside.read_bytes(), b'preserved')
        self.assertEqual(len(self.calls), 2)


if __name__ == '__main__':
    unittest.main()
