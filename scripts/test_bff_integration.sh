#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_ID="${FIREBASE_PROJECT_ID:-demo-bff-it}"
FIRESTORE_PORT="${FIRESTORE_EMULATOR_PORT:-8080}"
AUTH_PORT="${FIREBASE_AUTH_EMULATOR_PORT:-9099}"
STORAGE_PORT="${FIREBASE_STORAGE_EMULATOR_PORT:-9199}"
ORIGINAL_EMULATORS_PATH="${FIREBASE_EMULATORS_PATH:-$HOME/.cache/firebase/emulators}"
TMP_CONFIG=""
TMP_HOME=""

case "$PROJECT_ID" in
  demo-?*) ;;
  *)
    printf "[bff-integration] Refusing to run emulators for non-demo project: %s\n" "$PROJECT_ID" >&2
    exit 1
    ;;
esac

if command -v brew >/dev/null 2>&1; then
  if brew --prefix openjdk@21 >/dev/null 2>&1; then
    export PATH="$(brew --prefix openjdk@21)/bin:$PATH"
  fi
fi

export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:--Xms32m -Xmx768m}"

pick_free_port() {
  for p in "$@"; do
    if ! lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

resolve_port() {
  local label="$1"
  local requested="$2"
  shift 2
  if ! command -v lsof >/dev/null 2>&1 || ! lsof -iTCP:"$requested" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '%s\n' "$requested"
    return
  fi
  local alternate
  alternate="$(pick_free_port "$@" || true)"
  if [ -z "$alternate" ]; then
    printf "[bff-integration] %s emulator port %s is in use and no fallback port was found.\n" "$label" "$requested" >&2
    exit 1
  fi
  printf "[bff-integration] %s emulator port %s is busy. Using %s instead.\n" "$label" "$requested" "$alternate" >&2
  printf '%s\n' "$alternate"
}

cleanup() {
  if [ -n "${TMP_CONFIG:-}" ] && [ -f "$TMP_CONFIG" ]; then
    rm -f "$TMP_CONFIG"
  fi
  if [ -n "${TMP_HOME:-}" ] && [ -d "$TMP_HOME" ]; then
    rm -rf "$TMP_HOME"
  fi
}
trap cleanup EXIT

FIRESTORE_PORT="$(resolve_port Firestore "$FIRESTORE_PORT" 8081 8082 8083 8084 8085 8086 8087 8088 8089 8090 8180 8280)"
AUTH_PORT="$(resolve_port Auth "$AUTH_PORT" 9100 9101 9102 9103 9104 9105 9106 9107 9108 9109)"
STORAGE_PORT="$(resolve_port Storage "$STORAGE_PORT" 9200 9201 9202 9203 9204 9205 9206 9207 9208 9209)"

TMP_CONFIG="$(mktemp "$ROOT_DIR/.firebase-bff-integration.XXXXXX")"
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/bff-emulator-home.XXXXXX")"
node -e "const fs=require('fs');const cfg=JSON.parse(fs.readFileSync('firebase.json','utf8'));cfg.emulators=cfg.emulators||{};cfg.emulators.ui={enabled:false};for(const [name,port] of [['firestore',process.argv[2]],['auth',process.argv[3]],['storage',process.argv[4]]]){cfg.emulators[name]=cfg.emulators[name]||{};cfg.emulators[name].port=Number(port);}fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2));" "$TMP_CONFIG" "$FIRESTORE_PORT" "$AUTH_PORT" "$STORAGE_PORT"

run_emulator_suite() {
  local emulators="$1"
  local test_command="$2"
  env -i \
    HOME="$TMP_HOME" \
    PATH="$PATH" \
    TMPDIR="${TMPDIR:-/tmp}" \
    JAVA_HOME="${JAVA_HOME:-}" \
    JAVA_TOOL_OPTIONS="$JAVA_TOOL_OPTIONS" \
    CI="${CI:-1}" \
    FIREBASE_PROJECT_ID="$PROJECT_ID" \
    FIREBASE_EMULATORS_PATH="$ORIGINAL_EMULATORS_PATH" \
    npx firebase-tools emulators:exec \
    --only "$emulators" \
    --project "$PROJECT_ID" \
    --config "$TMP_CONFIG" \
    "$test_command"
}

printf "[bff-integration] Running Firestore integration tests (project=%s, port=%s)\n" "$PROJECT_ID" "$FIRESTORE_PORT"
run_emulator_suite firestore "npx vitest run --config vitest.bff-integration.config.ts"

printf "[bff-integration] Running Auth/Firestore/Storage rules integration test (project=%s, ports=%s/%s/%s)\n" "$PROJECT_ID" "$AUTH_PORT" "$FIRESTORE_PORT" "$STORAGE_PORT"
run_emulator_suite auth,firestore,storage "npx vitest run --config vitest.bff-integration.config.ts server/bff/storage-rules.integration.test.ts"
