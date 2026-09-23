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

## Container removal and crash recovery

Closed sessions keep their capacity reservation until `docker rm -f` exits successfully. Failed removal gets three bounded attempts, then remains unavailable for reuse. The broker retries unresolved tombstones once per minute (maximum four reserved sessions, three attempts each). `cleanupStatus` and `reservedSessions` expose unresolved cleanup; `activeSessions` counts running sessions only. `shutdown()` stops that periodic task and closes sessions; the host application must call it during graceful shutdown. Revoked owners can be removed with `revokeOwner` using an already verified principal. Idle sessions recheck authorization every 30 seconds.

A killed broker cannot execute its timers. The separate host reaper therefore inspects Docker containers labeled `io.myscube.axr.renderer=v1`, verifies the exact `axr-render-UUID` name and fixed image, and removes only containers whose Docker `Created` timestamp is older than five minutes plus a one-minute grace. Removal uses the inspected immutable container ID. It never removes arbitrary containers based only on their names. Each sweep is bounded to 100 inspections, 30 seconds overall, three seconds and 64KB per command. Failed cleanup is reported and retried on the next host timer tick.

`reapExpiredRenderers({ execute?, now? })` is exported from `reaper.mjs` for Docker QA. The CLI prints counts and container IDs; failures or incomplete sweeps exit nonzero. No application, cloud or Google credentials are needed. It uses the local Docker daemon only.

The supplied `systemd/myscube-axr-renderer-reaper.service` and `.timer` are **installation templates, not an installed service**. On an approved dedicated Linux Docker host, an operator must review `/opt/myscube-workbench`, `/usr/bin/node`, the `axr-runtime` account and existing Docker access, copy these units into `/etc/systemd/system`, then enable the timer. The timer runs once per minute independently of the broker. Docker socket access is host-level authority; this change does not create the account, grant Docker-group access, install the units or provision the host. Verify `systemctl status myscube-axr-renderer-reaper.timer` and journal results after the separately authorized installation.

Before opening its listener, a Docker-enabled broker must call `assertRendererHostReady()`. This read-only guard refuses startup whenever **any** container with the managed renderer label remains, including stopped containers. It does not spawn or delete containers and fails closed if Docker cannot be inspected. This avoids losing the four-container reservation across a broker process restart. Graceful cleanup or the independent host timer must clear previous containers before restarting the broker; crash recovery may require waiting for the remaining session TTL plus the 60-second grace (up to six minutes), then the next timer tick (up to roughly one further minute). Only this dedicated renderer host is gated; business services must not share its startup dependency. The guard assumes a single broker instance on that dedicated host; it is not a distributed lock for concurrent broker startup.
