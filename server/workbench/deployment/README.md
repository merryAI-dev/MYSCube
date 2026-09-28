# Release pair preparation and restoration

The app and the fixed renderer must be built from one reviewed source SHA. The app records the Node/platform, actual lockfile hashes and public Firebase authentication identity used by the build. Both images carry the source SHA and build classification. This is build metadata, not an independent provenance signature or approval to deploy.

`WORKBENCH_RELEASE_SHA` must be a full commit SHA. `WORKBENCH_BUILD_CLASS` is either `synthetic` or `production_candidate`. Synthetic app builds require a `demo-` authentication project and a `synthetic-` key. A production candidate rejects those settings. A missing release identity fails the build. See the Workbench CI workflow for the complete synthetic build commands. Real authentication configuration is supplied only after the target is approved.

## Prepare an existing image pair

On the approved Linux builder, the app must have tag `myscube-workbench-app:release` and the renderer `myscube-axr-renderer:1.58.2-v1`. The producer uses the local Unix Docker socket, an empty CLI configuration and fixed image IDs. It never pulls an image. Metadata inspection uses a bounded read-only container without external networking. Only that temporary inspection container may be removed by its own cleanup.

```sh
node server/workbench/deployment/create-release-bundle.mjs \
  --directory /approved-private-path/new-release \
  --source-sha FULL_REVIEWED_SOURCE_SHA \
  --classification production_candidate
```

The directory must not already exist. Output is exactly `manifest.json`, `app.docker.tar` and `renderer.docker.tar`. The format is Docker `image save`, not a custom application tar or an OCI image-layout directory. Archives are saved by image ID and may contain no repository tag. Restoration verifies the ID before assigning the fixed runtime tag. Docker documents [saving](https://docs.docker.com/reference/cli/docker/image/save/) and [loading](https://docs.docker.com/reference/cli/docker/image/load/) this format.

The producer prints the manifest digest. Its immediate self-check catches inconsistent output; that alone is not an independent trust channel. Record the digest and source SHA in a reviewed release record separately from the transferred bundle. An attacker replacing both a bundle and its alleged digest must not be able to authorize that release. Partial output after a failure is not a release and has no completed manifest.

## Verify without installing

```sh
node server/workbench/deployment/release-bundle.mjs verify \
  --directory /approved-private-path/new-release \
  --manifest-sha256 INDEPENDENTLY_TRUSTED_MANIFEST_DIGEST \
  --source-sha FULL_REVIEWED_SOURCE_SHA
```

Verification only reads files. It rejects missing/extra files, symlinks, hardlinks, changed files, invalid source or classification, excessive sizes and digest mismatches. It does not extract archives, invoke Docker or run scripts. Directory/file checks describe the bytes at verification time; use private immutable storage and re-verify immediately before restoration. Archive hashing does not inspect image contents or establish secret absence or host compatibility.

The `plan` command with the same arguments prints restoration commands for a `production_candidate` only. Synthetic bundles are rejected. The plan stops on existing different tags, checks image IDs/platform and does not install a service, credentials, IAM or systemd units. Existing services require a separate reviewed maintenance and rollback procedure. No plan is evidence that delivery or installation happened.

## CI evidence and remaining acceptance

The disposable CI job creates a synthetic pair, saves both exact IDs, removes only its own unused tags, proves the old IDs are absent, restores the archives and checks the same IDs and labels. It runs the actual app smoke and restores the `/app` payload to a fresh directory. That payload runs read-only at `/release` with the original `/app` completely hidden, no source checkout mounted, no `NODE_PATH`, and no external network. Health, static auth build settings, unauthenticated API rejection, React/Tailwind compilation, native DuckDB and graceful shutdown are checked. The restored renderer runs the actual isolation suite.

This proves execution with the app image's Node 24/glibc Linux base, not installation on an arbitrary host. The approved host must match the architecture and validate its Node/native-library compatibility. See the [dedicated host acceptance](../host-runtime/README.md).

Large archives exist only in the CI job's temporary directory and are deleted. Only small manifests and evidence JSON are retained. **This completes bundle creation/restoration verification, not artifact storage, delivery or production deployment.** No approved storage destination or dedicated host is configured yet. There is no automatic claim of measured model quality, live source access or a production error-rate reduction.
