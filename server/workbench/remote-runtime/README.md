# Remote React renderer

The browser receives PNG frames and sends bounded pointer/keyboard events. Generated JavaScript executes only in a per-session Chromium container. The host broker owns API permissions; the renderer has no credentials, host mounts or network. `callApi(context, { apiId, apiVersion, input, signal })` is the only data bridge and is checked against immutable session bindings.

Build from the repository root:

```sh
docker build -f server/workbench/remote-runtime/Dockerfile -t myscube-axr-renderer:1.58.2-v1 .
REQUIRE_REMOTE_DOCKER_QA=true node server/workbench/remote-runtime/docker-qa.mjs
```

The broker requires a dedicated Docker-capable host. It is not suitable for nested Docker inside Cloud Run. It does not connect to remote Docker APIs or provision resources. The image must already exist locally; runtime pulls are prohibited. The broker spawns only fixed `docker run` arguments and `docker rm -f` for its own UUID container names.

Each container runs as UID/GID 10001, read-only, without network, Linux capabilities or added privileges, with a 512 MiB memory/swap cap, one CPU, 128 PIDs, and capped `/tmp`/`/dev/shm` tmpfs. Chromium's own sandbox is disabled inside this container; the container boundary and restricted trusted IPC are the security boundary. This requires the real Linux Docker gate below, not a browser iframe test.

Limits: five-minute session TTL, eight-second frame/event deadline, one live session per actor plus one explicitly linked replacement candidate, four sessions total, 600 commands, 60 API calls and eight pending API calls. Images are bounded to 640 KB PNG with matching dimensions and sequence; JSON output is capped below 1 MB. The client keeps its last good frame until a candidate's first image is received, then closes the previous session. Failed candidates do not close the previous session.

`createRemoteRuntimeBroker` exposes `create`, `frame`, `event`, `close`, `closeAll`. Creation takes a trusted compiled `artifact`, matching `sourceHash`, immutable `apiBindings`, an optional viewport and optional `previousSessionId`. Never accept an artifact directly from a user request. `context.remoteEvidence`, when supplied by the host, remains the same object for trusted API evidence updates.

`worker.test.mjs` launches local Playwright with synthetic input to verify real React state, Tailwind and IPC. It is **not isolation evidence**. `docker-qa.mjs` must run against the built image on Linux Docker; it checks actual container settings, a network receiver, memory/infinite-loop/API-flood cases and another session's availability. Missing Docker prints SKIP; with `REQUIRE_REMOTE_DOCKER_QA=true` it fails the gate. No production source, records or credentials are used.
