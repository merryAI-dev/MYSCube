# AXR certificate renewal hook

This hook is scoped to the dedicated `axr.myscguard.app` host. It does not issue certificates, alter DNS/firewalls, edit nginx configuration, start nginx, or change `/etc/myscube-workbench/tls/key.pem`. Certbot standalone continues to use port 80; the bootstrap nginx configuration listens only on 443. Keep the existing certificate timer, rather than creating a second renewal schedule.

Certbot **2.1.0 supports `--reuse-key`** in its [CLI](https://github.com/certbot/certbot/blob/v2.1.0/certbot/certbot/_internal/cli/__init__.py#L207) and [renewal implementation](https://github.com/certbot/certbot/blob/v2.1.0/certbot/certbot/_internal/renewal.py#L348). Add that flag explicitly to the existing renewal service command; no dependency on newer `reconfigure` behavior is required. Do not add `--new-key`, `--no-reuse-key`, or a new key-type parameter. An intentional key rotation needs a separate reviewed maintenance operation.

## What the hook checks

`RENEWED_LINEAGE` must be exactly `/etc/letsencrypt/live/axr.myscguard.app` and `RENEWED_DOMAINS` must be exactly `axr.myscguard.app`. The live fullchain symlink must resolve to a regular, bounded, root-owned `fullchainN.pem` in the matching Certbot archive directory. The hook checks file identity before and after reading, rejects unsafe permissions/hardlinks, and validates a stable snapshot. It also checks the bootstrap activation domain and nginx's existing fullchain/key paths.

Node's X.509 implementation checks the leaf's exact DNS SAN, current validity, at least seven days remaining, and its match with the unchanged installed private key. OpenSSL verifies the chain for the TLS server purpose against Debian's system CA store. No certificate or key body is printed. Unexpected key rotation returns `tls_key_rotation_requires_maintenance` without replacing the installed chain.

For application, a mode-0644 root-owned fullchain is staged and fsynced in the existing TLS directory. One atomic rename publishes it; the key is never replaced, so there is no half-updated certificate/key pair. `nginx -t` then runs via `/usr/sbin/nginx`. Only an active nginx receives a reload. Inactive nginx remains inactive. On validation/reload failure, the previous fullchain is restored with another atomic rename and nginx configuration is checked again; if necessary the previous configuration is reloaded. Rollback failure retains recovery files and the lock for manual review.

## Install after source review

Transfer the reviewed **self-contained** `renew-tls.mjs`; it uses only Node builtins. Install it as root-owned, mode 0644 at `/usr/local/lib/myscube-workbench/renew-tls.mjs`. Do not overwrite a different existing hook without comparing it. Do not execute the workstation's copy against the VM implicitly.

Create a new root-owned mode-0755 script at `/etc/letsencrypt/renewal-hooks/deploy/50-myscube-workbench` only if that path does not already contain another hook:

```sh
#!/bin/sh
set -eu
case "${RENEWED_LINEAGE:-}" in
  /etc/letsencrypt/live/axr.myscguard.app) ;;
  *) exit 0 ;;
esac
exec /usr/bin/node /usr/local/lib/myscube-workbench/renew-tls.mjs --apply
```

The wrapper ignores unrelated lineages. The Node hook independently requires the exact lineage/domain and root on Linux. Preserve any unrelated hooks. The production paths cannot be overridden through CLI flags or environment variables.

Update the **existing** systemd renewal service's ExecStart to include `--reuse-key` and `--cert-name axr.myscguard.app` while preserving its approved flags. A representative command is:

```sh
/usr/bin/certbot renew --non-interactive --standalone --reuse-key --cert-name axr.myscguard.app
```

Inspect the actual unit before changing it; systemd requires an empty `ExecStart=` line before replacing a prior ExecStart in a drop-in. This document does not install or edit that unit. Do not create another timer or stop nginx for renewal when port 80 is already free.

## Verify without changing the installed chain

With the reviewed hook installed, root can validate the current production lineage without replacing the installed chain or reloading nginx:

```sh
RENEWED_LINEAGE=/etc/letsencrypt/live/axr.myscguard.app \
RENEWED_DOMAINS=axr.myscguard.app \
  /usr/bin/node /usr/local/lib/myscube-workbench/renew-tls.mjs --check
```

`--check` creates and removes private validation/lock files, but leaves the installed chain/key untouched. Then run the existing Certbot renewal **dry run without `--run-deploy-hooks`** to test the standalone challenge. Do not request forced production renewal just to test deployment. Certbot's [deploy hook documentation](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates) explains when hooks run; newer Certbot versions can explicitly run deploy hooks during dry runs, so keep that option off for this acceptance step.

After the first actual renewal, verify the hook's success status, served certificate fingerprint/expiry, nginx service state, and unchanged installed key hash. Local synthetic certificate tests prove the file/state path and cryptographic checks, not actual ACME renewal, port-80 availability, or nginx reload on this VM.

## Failure and retry

Certbot can successfully renew its own lineage even when a deploy hook fails. A later timer run might decide no renewal is due and **not run the failed deploy hook again**. Monitor both hook failures and the expiry of the certificate actually served on 443. Certbot's overall exit status alone is not sufficient evidence that nginx uses the renewed certificate. This script does not create an alert channel or policy.

For a recoverable failure, confirm the source lineage and unchanged installed key, fix the reported cause, then explicitly rerun the same command above with `--apply`. Repeating the same already-installed chain returns `unchanged` without a reload. If the key rotated, keep the existing working pair and perform a separately reviewed key/certificate maintenance operation; the hook does not silently replace the key.

Concurrent hooks are blocked by `/etc/myscube-workbench/tls/.renewal-lock`. A hard crash or rollback failure can leave it behind. Check its root-owned `owner.json` token/PID/start time, ensure no matching renewal process is still active (do not rely only on PID because it can be reused), pause the certificate timer while inspecting, and compare the served and installed certificate plus any `.rollback-*.pem` files. Only the operator may remove the exact confirmed stale lock after the installed pair and nginx state are understood. Do not broadly delete the TLS directory or other Certbot state. Retry `--check`, then explicit `--apply`, and resume the existing timer after verification.
