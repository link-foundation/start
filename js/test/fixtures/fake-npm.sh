#!/bin/sh
# Fake `npm` for js/test/npm-publish.mjs (issue #234). State lives in
# $FAKE_NPM_STATE: `published` marks the version as on the registry,
# `mode` picks how `npm run changeset:publish` behaves, `calls` logs argv.
# Any other command goes to $REAL_NPM when set (use-m runs `npm root -g`).
state="${FAKE_NPM_STATE:?}"
echo "$*" >> "$state/calls"
case "$1" in
  view)
    if [ -f "$state/outage" ]; then
      echo "npm error code ECONNRESET" >&2
      exit 1
    fi
    if [ -f "$state/published" ]; then
      cat "$state/published"
      exit 0
    fi
    echo "npm error code E404" >&2
    exit 1
    ;;
  run)
    mode="$(cat "$state/mode" 2>/dev/null || echo succeed)"
    case "$mode" in
      succeed) echo "$FAKE_NPM_VERSION" > "$state/published"; exit 0 ;;
      fail) echo "npm error code E403" >&2; exit 1 ;;
      exit-0-without-publishing) exit 0 ;;
      fail-after-landing) echo "$FAKE_NPM_VERSION" > "$state/published"; exit 1 ;;
      fail-once)
        echo succeed > "$state/mode"
        echo "npm error code E503" >&2
        exit 1
        ;;
    esac
    ;;
esac
if [ -n "${REAL_NPM:-}" ]; then
  exec "$REAL_NPM" "$@"
fi
echo "fake npm: unexpected arguments: $*" >&2
exit 2
