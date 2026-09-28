#!/usr/bin/env bash

bootstrap_approved_debian_url() {
  case "$1" in
    https://deb.debian.org/debian|https://deb.debian.org/debian/|https://deb.debian.org/debian-security|https://deb.debian.org/debian-security/|https://security.debian.org/debian-security|https://security.debian.org/debian-security/) return 0 ;;
    *) return 1 ;;
  esac
}

bootstrap_validate_mirror_text() {
  local text=$1 line trimmed found=false
  while IFS= read -r line || [[ -n $line ]]; do
    trimmed=${line#"${line%%[![:space:]]*}"}
    trimmed=${trimmed%"${trimmed##*[![:space:]]}"}
    [[ -z $trimmed || $trimmed == \#* ]] && continue
    bootstrap_approved_debian_url "$trimmed" || return 1
    found=true
  done <<< "$text"
  [[ $found == true ]]
}

bootstrap_validate_mirror_stat() {
  local owner mode links bytes remainder
  read -r owner mode links bytes remainder <<< "$1"
  [[ $owner == 0 && $links == 1 && $mode =~ ^[0-7]{3,4}$ && $bytes =~ ^[0-9]+$ && $bytes -gt 0 && $bytes -le 4096 ]] || return 1
  (( (8#$mode & 022) == 0 ))
}

bootstrap_read_approved_mirror() {
  local file=$1 before after text directory
  case "$file" in /etc/apt/mirrors/debian.list|/etc/apt/mirrors/debian-security.list) ;; *) return 1 ;; esac
  for directory in /etc /etc/apt /etc/apt/mirrors; do [[ -d $directory && ! -L $directory ]] || return 1; done
  [[ -f $file && ! -L $file ]] || return 1
  before=$(stat -c '%u %a %h %s %d:%i:%y:%z' -- "$file") || return 1
  bootstrap_validate_mirror_stat "$before" || return 1
  text=$(cat -- "$file") || return 1
  after=$(stat -c '%u %a %h %s %d:%i:%y:%z' -- "$file") || return 1
  [[ $before == "$after" ]] || return 1
  bootstrap_validate_mirror_text "$text" || return 1
  printf '%s\n' "$text"
}

bootstrap_candidate_sources() {
  LC_ALL=C awk '
    $1 == "Candidate:" { candidate=$2; next }
    $1 == "***" && NF == 3 && $3 ~ /^[0-9]+$/ { selected=($2 == candidate); next }
    NF == 2 && $2 ~ /^[0-9]+$/ { selected=($1 == candidate); next }
    selected && $1 ~ /^[0-9]+$/ && $2 != "/var/lib/dpkg/status" { print $2 }
  ' <<< "$1"
}

bootstrap_assert_package_origin() {
  local kind=$1 policy=$2 sources uri found=false
  sources=$(bootstrap_candidate_sources "$policy") || return 1
  while IFS= read -r uri; do
    [[ -n $uri ]] || continue
    if [[ $kind == docker ]]; then
      [[ $uri == https://download.docker.com/linux/debian || $uri == https://download.docker.com/linux/debian/ ]] || return 1
    elif [[ $kind == debian ]]; then
      case "$uri" in
        mirror+file:/etc/apt/mirrors/debian.list|mirror+file:/etc/apt/mirrors/debian-security.list)
          bootstrap_read_approved_mirror "${uri#mirror+file:}" >/dev/null || return 1 ;;
        *) bootstrap_approved_debian_url "$uri" || return 1 ;;
      esac
    else return 1
    fi
    found=true
  done <<< "$sources"
  [[ $found == true ]]
}
