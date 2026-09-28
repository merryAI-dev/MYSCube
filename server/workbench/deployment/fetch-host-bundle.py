#!/usr/bin/env python3
"""Fetch only pinned release bytes. The reviewed JS verifier must run before use."""
import argparse
import hashlib
import json
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BUCKET = 'myscube-axr-releases-20260924'
FILES = {'app': ('myscube-workbench-app:release', 'app.docker.tar'),
         'renderer': ('myscube-axr-renderer:1.58.2-v1', 'renderer.docker.tar')}
MANIFEST_LIMIT, ARCHIVE_LIMIT, CHUNK = 65536, 8 * 1024 ** 3, 1024 ** 2


def require(condition):
    if not condition:
        raise ValueError('bundle_fetch_rejected')


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys.split()))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def validate_manifest(raw, source):
    m = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object,
                   parse_constant=lambda _: require(False))
    exact(m, 'schemaVersion format sourceSha classification platform requirements build images')
    require(type(m['schemaVersion']) is int and m['schemaVersion'] == 1)
    require(m['format'] == 'docker-save' and m['sourceSha'] == source and m['classification'] == 'production_candidate')
    require(m['platform'] == {'os': 'linux', 'architecture': 'amd64'})
    exact(m['requirements'], 'nodeMajor libc minimumGlibc docker')
    require(type(m['requirements']['nodeMajor']) is int and m['requirements'] ==
            {'nodeMajor': 24, 'libc': 'glibc', 'minimumGlibc': '2.36', 'docker': 'local-linux'})
    exact(m['build'], 'nodeVersion auth locks')
    require(matches(r'v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)', m['build']['nodeVersion']))
    exact(m['build']['auth'], 'projectId domain apiKeySha256')
    require(all(isinstance(v, str) and 0 < len(v) <= 253 for v in m['build']['auth'].values()))
    exact(m['build']['locks'], 'root workbench')
    require(all(matches(r'[a-f0-9]{64}', v) for v in [m['build']['auth']['apiKeySha256'], *m['build']['locks'].values()]))
    require(type(m['images']) is list and len(m['images']) == 2)
    roles, ids = set(), set()
    for image in m['images']:
        exact(image, 'role tag id archive bytes sha256')
        role = image['role']
        require(isinstance(role, str) and role in FILES and role not in roles)
        require((image['tag'], image['archive']) == FILES[role])
        require(matches(r'sha256:[a-f0-9]{64}', image['id']) and image['id'] not in ids)
        require(type(image['bytes']) is int and 0 < image['bytes'] <= ARCHIVE_LIMIT)
        require(matches(r'[a-f0-9]{64}', image['sha256']))
        roles.add(role)
        ids.add(image['id'])
    return m


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('bundle_redirect_forbidden')


def read_token(stream):
    line = stream.readline(8194)
    require(line.endswith(b'\n') and len(line) <= 8193 and stream.read(1) == b'')
    token = line[:-1].decode('ascii')
    require(matches(r'[A-Za-z0-9._~+/-]+=*', token))
    return token


def fetch_bundle(source, manifest_sha, directory, token, *, opener=None, uid=0):
    require(matches(r'[a-f0-9]{40}', source) and matches(r'[a-f0-9]{64}', manifest_sha))
    require(matches(r'[A-Za-z0-9._~+/-]+=*', token) and len(token) <= 8192)
    require(isinstance(directory, str) and 0 < len(directory) <= 4096 and not re.search(r'[\x00-\x1f\x7f]', directory))
    require(os.path.isabs(directory) and os.path.normpath(directory) == directory and directory != '/')
    parent, name = os.path.split(directory)
    require(os.path.realpath(parent) == parent)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + 900
    parent_fd = os.open(parent, flags)
    try:
        p = os.fstat(parent_fd)
        require(p.st_uid == uid and p.st_mode & 0o022 == 0)
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        directory_fd = os.open(name, flags, dir_fd=parent_fd)
        try:
            os.fchmod(directory_fd, 0o700)
            own = os.fstat(directory_fd)
            require(own.st_uid == uid)

            def download(filename, limit, digest, size=None):
                require(filename in ('manifest.json', 'app.docker.tar', 'renderer.docker.tar'))
                obj = urllib.parse.quote('releases/' + source + '/' + filename, safe='')
                url = 'https://storage.googleapis.com/storage/v1/b/' + BUCKET + '/o/' + obj + '?alt=media'
                request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token, 'Accept-Encoding': 'identity'})
                require(time.monotonic() < deadline)
                with opener.open(request, timeout=30) as response:
                    require(response.status == 200 and response.headers.get('Content-Encoding', 'identity') == 'identity')
                    length = response.headers.get('Content-Length')
                    require(length is None or (matches(r'[0-9]{1,12}', length) and 0 < int(length) <= limit and (size is None or int(length) == size)))
                    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
                    with os.fdopen(fd, 'wb') as output:
                        os.fchmod(output.fileno(), 0o600)
                        count, hasher, parts = 0, hashlib.sha256(), []
                        while True:
                            require(time.monotonic() < deadline)
                            chunk = response.read1(min(CHUNK, limit + 1 - count))
                            require(time.monotonic() < deadline)
                            if not chunk:
                                break
                            count += len(chunk)
                            require(count <= limit)
                            hasher.update(chunk)
                            output.write(chunk)
                            if filename == 'manifest.json':
                                parts.append(chunk)
                        require(count > 0 and (size is None or count == size) and hasher.hexdigest() == digest)
                        output.flush()
                        os.fsync(output.fileno())
                        current = os.stat(filename, dir_fd=directory_fd, follow_symlinks=False)
                        written = os.fstat(output.fileno())
                        require((current.st_dev, current.st_ino) == (written.st_dev, written.st_ino))
                        require(stat.S_ISREG(current.st_mode) and current.st_nlink == 1 and current.st_uid == uid and stat.S_IMODE(current.st_mode) == 0o600 and current.st_size == count)
                    return b''.join(parts)

            raw = download('manifest.json', MANIFEST_LIMIT, manifest_sha)
            manifest = validate_manifest(raw, source)
            for image in manifest['images']:
                download(image['archive'], image['bytes'], image['sha256'], image['bytes'])
            require(sorted(os.listdir(directory_fd)) == ['app.docker.tar', 'manifest.json', 'renderer.docker.tar'])
            current = os.stat(directory, follow_symlinks=False)
            require(os.path.realpath(directory) == directory and (own.st_dev, own.st_ino) == (current.st_dev, current.st_ino))
            require(current.st_uid == uid and stat.S_IMODE(current.st_mode) == 0o700)
            os.fsync(directory_fd)
            os.fsync(parent_fd)
        finally:
            os.close(directory_fd)
    finally:
        os.close(parent_fd)
    return {'downloaded': True, 'sourceSha': source, 'manifestSha256': manifest_sha, 'files': 3, 'requiresReleaseVerification': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source-sha', 'manifest-sha256', 'directory'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        result = fetch_bundle(args.source_sha, args.manifest_sha256, args.directory, read_token(sys.stdin.buffer), uid=os.geteuid())
        print(json.dumps(result))
        return 0
    except (Exception, KeyboardInterrupt):
        print('Bundle fetch failed. Do not use the incomplete directory; release verification is required.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
