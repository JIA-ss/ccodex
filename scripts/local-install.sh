#!/bin/sh
# Build this checkout and install it as its own version under ~/.ccodex/versions, beside the one in use.
# Nothing running is touched: the version in use changes only with --activate, and the gateway picks it up
# at its next restart (codex app-server daemon restart).
#
#   scripts/local-install.sh [--activate] [--skip-tests] [--relay PATH]
#
#   --relay PATH   use this relay binary instead of building relay/ with cargo
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CCODEX_HOME=${CCODEX_HOME:-"$HOME/.ccodex"}
ACTIVATE=0; TESTS=1; RELAY=
while [ $# -gt 0 ]; do
  case "$1" in
    --activate) ACTIVATE=1 ;;
    --skip-tests) TESTS=0 ;;
    --relay) RELAY=$2; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash the changes in $ROOT first: a local build is named after its commit." >&2
  exit 1
fi
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=relay-darwin-arm64 ;;
  Linux-aarch64) PLATFORM=relay-linux-arm64-gnu ;;
  Linux-x86_64) PLATFORM=relay-linux-x64-gnu ;;
  *) echo "Unsupported platform for a local build: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
BASE=$(node -p "require('./package.json').version.replace(/-.*/, '')")
VERSION="$BASE-local.$(date -u +%Y%m%d%H%M).$(git rev-parse --short=8 HEAD)"
TARGET="$CCODEX_HOME/versions/$VERSION"
[ -e "$TARGET" ] && { echo "$TARGET already exists." >&2; exit 1; }

[ -d node_modules ] || npm ci --ignore-scripts --no-audit --no-fund
./node_modules/.bin/tsc -p tsconfig.json --noEmit
node scripts/check-public-tree.mjs
if [ "$TESTS" = 1 ]; then
  ./node_modules/.bin/vitest run --config config/vitest.config.ts --exclude 'tests/listener-recovery.test.mjs'
fi

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/ccodex-local.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD | tar -x -C "$STAGE"
ln -s "$ROOT/node_modules" "$STAGE/node_modules"
(cd "$STAGE" && ./node_modules/.bin/tsc -p config/tsconfig.build.json)

if [ -z "$RELAY" ]; then
  PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path "$ROOT/relay/Cargo.toml" --release
  RELAY="${CARGO_TARGET_DIR:-$ROOT/relay/target}/release/codex-hybrid-remote-relay"
fi
[ -x "$RELAY" ] || { echo "No relay binary at $RELAY" >&2; exit 1; }
mkdir -p "$STAGE/packages/$PLATFORM/bin"
install -m 755 "$RELAY" "$STAGE/packages/$PLATFORM/bin/ccodex-relay"

# Name both packages after this build; only this platform's relay exists at that version.
VERSION=$VERSION PLATFORM=$PLATFORM node - "$STAGE" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const stage = process.argv[2], { VERSION, PLATFORM } = process.env;
const edit = (path, change) => { const value = JSON.parse(readFileSync(path, "utf8")); change(value); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
edit(join(stage, "package.json"), (main) => {
  main.version = VERSION;
  main.optionalDependencies = { [`@gkorepanov/ccodex-${PLATFORM}`]: VERSION };
  delete main.scripts.prepack;
});
edit(join(stage, "packages", PLATFORM, "package.json"), (relay) => { relay.version = VERSION; });
NODE
rm "$STAGE/node_modules"
MAIN=$(cd "$STAGE" && npm pack --ignore-scripts --silent)
RELAY_PACK=$(cd "$STAGE/packages/$PLATFORM" && npm pack --ignore-scripts --silent)

mkdir -p "$CCODEX_HOME/versions"
rm -rf "$TARGET.installing"
npm install --prefix "$TARGET.installing" --include=optional --ignore-scripts --save=false --no-audit --no-fund \
  "$STAGE/$MAIN" "$STAGE/packages/$PLATFORM/$RELAY_PACK"
INSTALLED="$TARGET.installing/node_modules/@gkorepanov/ccodex"
[ -x "$TARGET.installing/node_modules/@gkorepanov/ccodex-$PLATFORM/bin/ccodex-relay" ] || { echo "Relay missing from the install." >&2; exit 1; }
find "$INSTALLED/dist" -name '*.js' -exec node --check {} \;
(cd "$STAGE/dist" && find . -name '*.js' | while read -r file; do cmp -s "$file" "$INSTALLED/dist/$file" || { echo "Installed $file differs from the build." >&2; exit 1; }; done)
mv "$TARGET.installing" "$TARGET"
echo "Installed $VERSION at $TARGET"

if [ "$ACTIVATE" = 1 ]; then
  PREVIOUS=$(readlink "$CCODEX_HOME/current" 2>/dev/null || true)
  printf '%s\n' "$PREVIOUS" > "$CCODEX_HOME/versions/.previous"
  ln -s "versions/$VERSION" "$CCODEX_HOME/current.next" && mv -f -h "$CCODEX_HOME/current.next" "$CCODEX_HOME/current" 2>/dev/null \
    || { rm -f "$CCODEX_HOME/current.next"; ln -sfn "versions/$VERSION" "$CCODEX_HOME/current"; }
  echo "Activated (was: ${PREVIOUS:-none}). Restart the gateway when it is idle: codex app-server daemon restart"
else
  echo "Not activated. To use it: ln -sfn versions/$VERSION $CCODEX_HOME/current, then restart the gateway."
fi
