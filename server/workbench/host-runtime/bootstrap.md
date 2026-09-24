# Initial Debian host bootstrap

This procedure is for a **new, approved, dedicated Debian 12 amd64 VM**. It is not an upgrade or rollback procedure. It does not create cloud resources, IAM grants, DNS records, certificates, API keys or source-copy accounts. The scripts default to plans; changing the host requires both `--apply` and `--dedicated-host`. Run them from the separately reviewed source checkout. Keep cloud ingress closed until acceptance is complete.

The runtime identity may access the isolated database and the approved authentication user-verification service. Never attach the source-copy identity to this VM or grant the VM source-copy impersonation. Docker-group membership is effectively host-level authority. Source Firestore and Google Sheets credentials belong in a separately scheduled execution environment, not another user on this Docker host. A project ID in configuration is an identity check, not an IAM restriction.

## 1. Prerequisites

Choose a Node **24.x.y** release and independently verify the SHA256 of its official **linux-x64.tar.xz** archive using the signed release checksums. Do not use the checksum downloaded alongside an untrusted archive as the sole approval. Node publishes [release verification instructions](https://github.com/nodejs/node#verifying-binaries). Set the reviewed version and digest below; these values are not discovered automatically.

```sh
bash server/workbench/host-runtime/bootstrap-host.sh \
  --node-version 24.x.y --node-sha256 TRUSTED_NODE_ARCHIVE_SHA256
```

After reviewing the plan, run the same command with `--apply --dedicated-host` as root on the approved VM. It checks Debian 12, amd64 and glibc >=2.36; installs the official Node binary and signed Docker apt packages; installs Debian's nginx; and creates `axr-runtime` with no login shell or home directory. It does not run downloaded scripts or use curl-to-shell pipelines. A fixed Docker signing-key fingerprint change stops installation for review. Existing conflicting packages and active services are not removed.

Keep `bootstrap-apt-policy.sh` alongside `bootstrap-host.sh` when transferring the reviewed scripts. The origin check examines the selected apt candidate, not an unrelated older package version. Debian 12 GCE's `mirror+file:/etc/apt/mirrors/debian.list` and `debian-security.list` are accepted only after checking the fixed files' ownership, permissions and exact official HTTPS Debian endpoints. Mixed or unrecognized mirror URLs are rejected; apt signature verification is not disabled. This is Debian's documented [local mirror-list transport](https://manpages.debian.org/bookworm/apt/apt-transport-mirror.1.en.html).

Sources: [Docker's signed apt installation](https://docs.docker.com/engine/install/debian/), [Debian nginx package](https://packages.debian.org/bookworm/nginx). Exact installed package versions are recorded under `/etc/myscube-workbench/installed-package-versions.txt`. Apt service autostart is temporarily suppressed, and Docker alone is started after installation. The temporary package policy is removed by cleanup; a pre-existing policy is never replaced. If package installation fails, review installed state before retrying; the script is not a package rollback manager.

## 2. Stage the approved release

Transfer only the reviewed Docker-save bundle (`manifest.json`, `app.docker.tar`, `renderer.docker.tar`) through the approved delivery channel. Supply the source SHA and manifest digest from a separate trusted release record. Do not transfer developer ADC, `.env`, source-copy credentials or a workstation's `node_modules`.

```sh
node server/workbench/host-runtime/bootstrap-install.mjs stage \
  --directory /root/approved-bundle \
  --manifest-sha256 TRUSTED_MANIFEST_SHA256 --source-sha REVIEWED_FULL_SHA
```

Add `--apply --dedicated-host` for installation. The existing release-bundle verifier requires a production candidate. The installer loads exact image IDs through the local Docker socket, verifies architecture and labels, and copies `/app` from a **never-started** inspection container. It verifies build metadata and lockfile digests, rejects escaping symlinks and special files, and makes the payload root-owned and unwritable by the runtime user. The release directory and fixed renderer tag are prepared before publishing `/opt/myscube-workbench`. Any existing release link or different fixed image tag stops the initial-install path. No running container is stopped or arbitrary image removed.

Only the installer-created temporary inspection container and its private staging directory are cleaned up. A failed partial installation can leave loaded images or an unpublished completed release; retain it for inspection. The script does not claim transactional rollback of Docker and filesystem state. It never starts the app before the image pair and receipt exist.

## 3. Configuration and TLS

Prepare a root-owned, mode-0600 JSON file containing string-valued runtime settings. It is parsed as JSON, never sourced or evaluated as shell code. Example identifiers below are placeholders; they are not approved resources.

```json
{
  "WORKBENCH_PROJECT_ID": "approved-isolated-data",
  "PRODUCTION_PROJECT_ID": "approved-business-data",
  "WORKBENCH_MODEL_PROJECT_ID": "approved-isolated-model",
  "PRODUCTION_MODEL_PROJECT_ID": "approved-business-model",
  "WORKBENCH_AUTH_PROJECT_ID": "approved-identity",
  "WORKBENCH_TENANT_ID": "approved-tenant",
  "WORKBENCH_APP_ORIGIN": "https://workbench.example.org",
  "WORKBENCH_AI_ENABLED": "false",
  "WORKBENCH_READS_ENABLED": "true",
  "WORKBENCH_REMOTE_RUNTIME_ENABLED": "true",
  "WORKBENCH_REMOTE_RUNTIME_DRIVER": "docker-host"
}
```

The authentication project must match the baked frontend build. New identity projects do not automatically preserve source membership UIDs. Verify that the login UID matches the copied permission document. The source-copy scheduler must refresh permission copies within five minutes; this script does not schedule that job.

For AI, add the approved `WORKBENCH_HTML_MODEL` and dedicated `WORKBENCH_GEMINI_API_KEY` only after model quota approval. For Git, supply all dedicated GitHub App fields, repository and credential mode together. The private key may be a JSON string containing escaped newlines; the output uses systemd EnvironmentFile quoting, not shell expansion. Credentials are not printed. Legacy production/JVM keys, ADC key paths, copy/import switches, arbitrary external endpoints and public-test flags are rejected by the allowlist.

Supply a CA-issued **leaf certificate**, intermediate **chain**, and matching unencrypted private key. The leaf must cover the chosen domain, validate against the host CA store and remain valid for at least seven days. Self-signed leaf certificates are rejected. Certificate renewal remains an operator responsibility; this bootstrap does not register an ACME account. Certificate/key inputs must be regular root-owned files, and the private key must be mode 0600. The resulting key stays root-only. Nginx's root master loads it before worker privilege separation.

```sh
node server/workbench/host-runtime/bootstrap-install.mjs configure \
  --source-sha REVIEWED_FULL_SHA --configuration /root/workbench-runtime.json \
  --domain workbench.example.org --certificate /root/tls/leaf.pem \
  --chain /root/tls/chain.pem --private-key /root/tls/key.pem
```

Add `--apply --dedicated-host` after review. This installs the fixed app and reaper systemd units and a TLS-only nginx virtual host. Existing unrelated nginx sites cause refusal. The Debian default site symlink is moved intact into the private configuration directory for possible restoration; no public welcome page is enabled. The proxy forwards only to `127.0.0.1:8791`, uses a 1 MiB request limit and 130-second upstream deadline, and preserves the application's CSP and other security headers. It does not configure a permissive CORS proxy. `systemd-analyze verify` and `nginx -t` must pass. These are configuration checks, not production acceptance.

## 4. Explicit activation and acceptance

```sh
node server/workbench/host-runtime/bootstrap-install.mjs activate \
  --source-sha REVIEWED_FULL_SHA
```

Add `--apply --dedicated-host` only on the approved host. Activation rechecks the installed image pair and configuration hash, starts the independent reaper timer, checks for leftover renderer containers, starts the app, and requires loopback health plus an unauthenticated API **401**. Only then does it start nginx and verify local TLS with the real host name and CA validation. If activation fails after starting these services, it stops only the app/proxy it started and leaves the reaper running. Services are enabled for reboot only after these checks pass.

Before opening cloud ingress, independently verify external DNS/TLS, authorized and revoked accounts, source-copy freshness, real model invocation, generated React interaction, API access withdrawal, all four renderer resource limits/network denial, failed-candidate preservation, and broker crash/reaper/restart. The bootstrap output explicitly lists remaining acceptance. Synthetic tests, shell syntax and unit files cannot prove these host behaviours. No source business data or saved Workbench versions are modified by host installation.

Logs use the journal. Configure a bounded retention policy and disk alerts on the dedicated host. Keep an approved previous app/renderer pair for rollback; use the separate maintenance procedure rather than rerunning the initial installer over an active release.
