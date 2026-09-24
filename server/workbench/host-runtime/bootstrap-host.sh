#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/bootstrap-apt-policy.sh"
node_version=''
node_sha256=''
apply=false
dedicated=false
while (($#)); do
  case "$1" in
    --node-version) [[ $# -ge 2 && -z "$node_version" ]] || fail 'Missing/duplicate Node version.'; node_version=$2; shift 2 ;;
    --node-sha256) [[ $# -ge 2 && -z "$node_sha256" ]] || fail 'Missing/duplicate Node digest.'; node_sha256=$2; shift 2 ;;
    --apply) [[ $apply == false ]] || fail 'Duplicate apply flag.'; apply=true; shift ;;
    --dedicated-host) [[ $dedicated == false ]] || fail 'Duplicate host flag.'; dedicated=true; shift ;;
    --help) printf '%s\n' 'bootstrap-host.sh --node-version 24.x.y --node-sha256 TRUSTED_LINUX_X64_ARCHIVE_SHA256 [--apply --dedicated-host]'; exit 0 ;;
    *) fail 'Unsupported argument.' ;;
  esac
done
[[ $node_version =~ ^24\.[0-9]+\.[0-9]+$ && $node_sha256 =~ ^[a-f0-9]{64}$ ]] || fail 'An explicit Node 24 version and independently verified archive SHA256 are required.'
printf '%s\n' "Plan: Debian 12 amd64; Node v${node_version}; official Docker apt packages; Debian nginx; axr-runtime account. No cloud IAM, source credentials, TLS issuance or application activation."
[[ $apply == true ]] || exit 0
[[ $dedicated == true && $EUID -eq 0 ]] || fail 'Apply requires root and --dedicated-host on the approved new host.'
[[ $(uname -s) == Linux && $(dpkg --print-architecture) == amd64 ]] || fail 'Debian amd64 Linux is required.'
[[ $(sed -n 's/^ID=//p' /etc/os-release | tr -d '"') == debian && $(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"') == 12 ]] || fail 'Debian 12 is required.'
[[ $(getconf GNU_LIBC_VERSION) == glibc\ * ]] || fail 'glibc is required.'
dpkg --compare-versions "$(getconf GNU_LIBC_VERSION | cut -d ' ' -f 2)" ge 2.36 || fail 'glibc >= 2.36 is required.'
[[ ! -e /opt/myscube-workbench && ! -L /opt/myscube-workbench ]] || fail 'An existing Workbench release needs a separate maintenance plan.'
for service in nginx myscube-axr-workbench; do
  if systemctl is-active --quiet "$service"; then fail 'An existing active service requires operator review.'; fi
done
[[ ! -e /usr/sbin/policy-rc.d ]] || fail 'Existing package service-start policy must be reviewed; it will not be replaced.'
for package in docker.io docker-compose docker-doc docker-buildx podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then fail 'Conflicting container package exists; nothing will be uninstalled automatically.'; fi
done
if [[ -e /usr/bin/node || -L /usr/bin/node ]]; then
  [[ $(/usr/bin/node --version) == "v${node_version}" ]] || fail 'Existing Node differs from the approved version; it will not be overwritten.'
fi
for file in /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources; do
  [[ ! -e $file && ! -L $file ]] || fail 'Existing Docker apt configuration requires review.'
done
scratch=$(mktemp -d /var/tmp/axr-bootstrap.XXXXXXXX)
policy_created=false
cleanup() {
  if [[ $policy_created == true ]]; then rm -f -- /usr/sbin/policy-rc.d; fi
  [[ $scratch == /var/tmp/axr-bootstrap.* ]] && rm -rf -- "$scratch"
}
trap cleanup EXIT
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod 0755 /usr/sbin/policy-rc.d
policy_created=true
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg xz-utils openssl
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 60 https://download.docker.com/linux/debian/gpg --output "$scratch/docker.asc"
fingerprint=$(gpg --batch --show-keys --with-colons "$scratch/docker.asc" | awk -F: '$1 == "fpr" { print $10; exit }')
[[ $fingerprint == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]] || fail 'Docker signing key changed; explicit review is required.'
install -m 0755 -d /etc/apt/keyrings
install -m 0644 "$scratch/docker.asc" /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: bookworm
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
chmod 0644 /etc/apt/sources.list.d/docker.sources
apt-get update
docker_policy=$(LC_ALL=C apt-cache policy docker-ce)
nginx_policy=$(LC_ALL=C apt-cache policy nginx)
bootstrap_assert_package_origin docker "$docker_policy" || fail 'Official Docker apt candidate origin is missing.'
bootstrap_assert_package_origin debian "$nginx_policy" || fail 'Approved Debian nginx candidate origin is missing.'
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io nginx
archive="node-v${node_version}-linux-x64.tar.xz"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 180 "https://nodejs.org/dist/v${node_version}/${archive}" --output "$scratch/$archive"
printf '%s  %s\n' "$node_sha256" "$scratch/$archive" | sha256sum --check --status || fail 'Node archive digest mismatch.'
tar -tJf "$scratch/$archive" > "$scratch/node-entries.txt"
while IFS= read -r entry; do
  [[ $entry == "node-v${node_version}-linux-x64/"* && $entry != *'../'* ]] || fail 'Unexpected Node archive path.'
done < "$scratch/node-entries.txt"
tar -xJf "$scratch/$archive" --no-same-owner --directory "$scratch"
[[ -x "$scratch/node-v${node_version}-linux-x64/bin/node" ]] || fail 'Node executable is missing.'
[[ $("$scratch/node-v${node_version}-linux-x64/bin/node" --version) == "v${node_version}" ]] || fail 'Node archive version mismatch.'
install -m 0755 -d /opt
[[ ! -e "/opt/node-v${node_version}-linux-x64" ]] || fail 'Node destination already exists; operator review is required.'
mv -- "$scratch/node-v${node_version}-linux-x64" /opt/
if [[ ! -e /usr/bin/node ]]; then ln -s "/opt/node-v${node_version}-linux-x64/bin/node" /usr/bin/node; fi
getent group axr-runtime >/dev/null || groupadd --system axr-runtime
if id axr-runtime >/dev/null 2>&1; then
  [[ $(getent passwd axr-runtime | cut -d: -f6-7) == /nonexistent:/usr/sbin/nologin ]] || fail 'Existing runtime account needs review.'
else
  useradd --system --gid axr-runtime --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin axr-runtime
fi
usermod -a -G docker axr-runtime
install -m 0700 -d /etc/myscube-workbench
dpkg-query -W -f='${Package}\t${Version}\n' docker-ce docker-ce-cli containerd.io nginx > /etc/myscube-workbench/installed-package-versions.txt
printf 'node\tv%s\nnode_archive_sha256\t%s\n' "$node_version" "$node_sha256" >> /etc/myscube-workbench/installed-package-versions.txt
rm -f -- /usr/sbin/policy-rc.d
policy_created=false
systemctl enable --now docker
printf '%s\n' 'Prerequisites installed. Nginx and Workbench were not activated. Proceed with reviewed release staging and production configuration.'
