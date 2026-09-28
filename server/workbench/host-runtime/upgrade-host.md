# Dedicated AXR host upgrade

`upgrade-host.mjs` updates an existing, reviewed Debian 12 amd64 / Node 24 installation on the independent AXR VM. It is not a general installer, zero-downtime rollout, schema migration, or database rollback tool. It performs no database or model calls. Existing business-service hosts and the separately scheduled source-copy worker are outside this tool's scope.

## Inputs and review

Run the reviewed tool as root on the dedicated host. The candidate bundle must have been built from the approved full Git commit, pass CI, and match an **externally obtained** manifest digest. Do not derive the trusted digest solely from the delivered manifest. The bundle verifier streams bounded hashes; archives are not buffered into memory or extracted with `tar` onto the host.

Create a root-owned, mode-0600 regular file containing exactly these current-installation pins. Values must be recorded independently before the upgrade:

```json
{
  "sourceSha": "<current 40-character Git SHA>",
  "receiptSha256": "<SHA-256 of /etc/myscube-workbench/release.json>",
  "configurationSha256": "<SHA-256 of /etc/myscube-workbench/runtime.env>",
  "nginxSha256": "<SHA-256 of /etc/nginx/conf.d/myscube-workbench.conf>",
  "appImageId": "sha256:<current exact app image ID>",
  "rendererImageId": "sha256:<current exact renderer image ID>"
}
```

Do not print `runtime.env`, supply cloud credentials to the tool, or source it in a shell. It reads the file only for the pinned-byte and explicit project-identity checks. Candidate public Firebase auth project/domain/key digest must be identical to the current release receipt. An auth, environment, TLS, systemd unit, service dependency, additional nginx site, or nonstandard host change requires a separate review; this upgrade refuses it.

Print-only verification/planning:

```bash
/usr/bin/node /root/reviewed-source/server/workbench/host-runtime/upgrade-host.mjs \
  --directory /root/approved-release-bundle \
  --source-sha <approved-candidate-full-SHA> \
  --manifest-sha256 <externally-trusted-manifest-SHA256> \
  --current-pins /root/current-pins.json
```

After the review and deployment authorization, use the identical command with `--apply --dedicated-host`. No commands in this runbook are an instruction to deploy from a developer's local worktree. The approved delivery workflow/operator controls the host invocation.

## Actual sequence

1. Verify candidate archives and strict manifest, then obtain the exclusive root-owned `/etc/myscube-workbench/.upgrade-lock`. Record owner token, PID, old pins and candidate manifest. Existing unresolved lock/journal blocks a second execution.
2. Compare current receipt, symlink, config digest, exact original nginx config, all three installed unit files, active reaper, current image tags, Debian/glibc and free space. The app must initially be enabled. Its reverse activation dependencies must contain only `WantedBy=multi-user.target`, with no `RequiredBy`, `TriggeredBy`, `PartOf`, `UpheldBy` or drop-ins.
3. Check Docker-save metadata is untagged **before** loading. Classic config IDs and Docker 29 containerd OCI index IDs are distinct supported forms. Referenced bounded OCI JSON blobs are hash/size checked and mutable-name annotations rejected. Reinspect immutable loaded IDs/platform/revision/classification, and prove current live tags unchanged. Copy `/app` from an unstarted network-disabled container, reject escaping symlinks/special files/hardlinks, seal ownership/modes, validate build metadata/lockfiles/public auth/static assets, and create a new SHA release directory. Existing directories are never overwritten.
4. Atomically replace only the exact AXR nginx config with the same config plus a server-level `return 503`. Check nginx and confirm TLS `/health` returns 503. No other nginx site may be installed. Existing in-flight requests may finish; this is not an instantaneous network-drain guarantee.
5. Persistently **disable** only the AXR app's normal boot activation, verify disabled, then stop it and require inactive. Keep the reaper timer active and require zero managed renderer containers. Any leftovers cause a closed failure for operator/reaper investigation, not broad deletion. Disabling alone does not stop a running service, so both operations are required. See [systemd's enable/disable contract](https://github.com/systemd/systemd/blob/main/man/systemctl.xml).
6. While the app is stopped and disabled, switch the two image tags, then the current release symlink, then release/activation receipts. Each write is checked; the multi-object change is not a filesystem transaction. Persistent disabled state and maintenance proxy are the interruption containment. The original base unit, environment and TLS files remain unchanged.
7. Revalidate the complete new pair/link/receipts/config. Run the candidate's `deployment/host-smoke.mjs` and `remote-runtime/docker-qa.mjs` as `axr-runtime` with a clean environment, a 180-second timeout per process and bounded output. The native script gets only the expected source SHA; the Docker script gets only its required-QA flag. No runtime/model/database credentials are passed. The Docker QA makes synthetic containers and a synthetic local positive-control listener; renderer network/resource/cleanup proof must pass with the exact candidate image ID. Root stores reports from stdout in the lock directory. Require zero managed containers again.
8. Explicitly start the still-disabled candidate. Require loopback health with the pinned independent project ID, both unauthenticated HTML/React APIs returning 401, exact served HTML/assets, matching pair/receipts and active reaper. Restore the exact original nginx file, validate/reload, then restore app boot enablement. Every awaited phase checks interruption before recording success.

Docker load can restore tags from an archive, which is why a verified digest alone is insufficient for the no-live-tag-change staging condition. See [Docker load](https://docs.docker.com/reference/cli/docker/image/load/) and [Docker save](https://docs.docker.com/reference/cli/docker/image/save/).

## Failure and recovery

After maintenance begins, a failure or handled interruption disables/stops the app and preserves maintenance. If nginx cannot safely reload the known maintenance config, the dedicated nginx service is stopped. An externally changed config is never overwritten. Failure to prove either containment step is reported as `upgrade_containment_unconfirmed`, not a successful rollback. **No old image, old writer or old database version is restarted automatically.** Schema-incompatible old releases are not valid rollback targets after new writes.

Before maintenance, a rejected preflight/stage leaves the current service untouched, retains the lock/journal and may leave newly loaded untagged images or a private staging directory. The tool does not delete unrelated Docker resources, reuse partial stages, retry writes, or automatically resume.

The stable root-only receipt is `/etc/myscube-workbench/upgrade-journal.json`. It contains old/new identities, intended path, phase/status and a bounded safe error code; it never contains environment values, command stderr or tokens. On success it records `phase=complete,status=completed`, and the lock directory is atomically renamed to `/etc/myscube-workbench/upgrade-completed-<owner-token>` with backups and synthetic reports. Keep these records for review.

On crash/SIGKILL, do not clear a lock based only on PID absence. Confirm the originating workflow/systemd upgrade process is terminal, its owner token matches the retained journal, and no second process is active. Independently inspect app active/enabled state, nginx status/config hash, current symlink, both exact image IDs, release/activation/config hashes and managed renderer count. A crash at a partial pair switch leaves boot activation disabled. Manual service starts can bypass a disabled unit; operators must not start it or re-enable it before resolving the recorded phase. This is not a defense against a privileged operator changing the host concurrently.

Preserve the failed records. A separately reviewed recovery must reconcile the **candidate pair** and compatibility of any writes; it must not blindly roll back, remove the lock, overwrite a staged SHA directory, or reopen traffic. After a verified success, perform authorized/revoked-account browser acceptance and copy freshness/model/API checks separately. The local smoke checks do not prove production data correctness or all user workflows.

Focused tests use injected command actions and real temporary files. They prove ordering, identity/permission guards, interruption handling and failure state contracts; they are not evidence that a real host was upgraded or that Docker isolation passed there.
