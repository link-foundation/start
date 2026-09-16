#!/bin/sh
# Reproduces the issue #171 lifetime drift seen on macOS CI (BSD `date`).
#
# The watcher snippet has two branches: GNU (`date -d ... +%s%3N`) and BSD
# (`date -j -f ... +%s`). Only the GNU branch runs on Linux, so the BSD bug
# stayed invisible locally. This stubs a BSD-shaped `date` so the fallback can
# be exercised anywhere. Run with `sh experiments/bsd-lifetime.sh`.
BIN=$(mktemp -d)
cat > "$BIN/date" <<'FAKE'
#!/bin/sh
# Minimal BSD `date`: rejects GNU's -d and %N, understands -j -f FMT STR +%s.
if [ "$1" = "-u" ] && [ "$2" = "-j" ] && [ "$3" = "-f" ]; then
  # On macOS /bin/date is already BSD and takes these flags as they stand; on
  # Linux it is GNU and rejects them, so translate to GNU's syntax instead.
  /bin/date "$@" 2>/dev/null && exit 0
  exec /bin/date -u -d "$(echo "$5" | tr 'T' ' ')" "$6"
fi
exit 1
FAKE
chmod +x "$BIN/date"
PATH="$BIN:$PATH"; export PATH

# --- the snippet under test (kept byte-identical to the shipped one) ---------
__start_command_millis() { case "$1" in *.*) __start_command_frac=${1#*.};; *) printf '000'; return;; esac; __start_command_frac=${__start_command_frac%%[!0-9]*}; printf '%.3s' "${__start_command_frac}000"; }
__start_command_epoch_ms() { __start_command_ts=$(date -u -d "$1" +%s%3N 2>/dev/null); case "$__start_command_ts" in ''|*[!0-9]*) __start_command_ts=$(date -u -j -f '%Y-%m-%dT%H:%M:%S' "${1%.*}" +%s 2>/dev/null) && __start_command_ts="${__start_command_ts}$(__start_command_millis "$1")";; esac; case "$__start_command_ts" in ''|*[!0-9]*) __start_command_ts='';; esac; printf '%s' "$__start_command_ts"; }
# ----------------------------------------------------------------------------

failed=0
check() {
  t0=$(__start_command_epoch_ms "$1"); t1=$(__start_command_epoch_ms "$2")
  if [ -n "$t0" ] && [ -n "$t1" ] && [ "$t1" -ge "$t0" ] 2>/dev/null; then
    ms=$((t1 - t0)); got="$((ms / 1000)).$(printf '%03d' "$((ms % 1000))")s"
  else got=unknown; fi
  if [ "$got" = "$3" ]; then echo "ok   $1 -> $2 = $got"
  else echo "FAIL $1 -> $2 = $got (want $3)"; failed=1; fi
}
check 2026-09-15T22:21:40.942007645Z 2026-09-15T22:21:46.740817278Z 5.798s
check 2026-09-15T22:21:40.000000000Z 2026-09-15T22:21:41.500000000Z 1.500s
check 2026-09-15T22:21:40Z           2026-09-15T22:21:41Z           1.000s
check 2026-09-15T22:21:40.9Z         2026-09-15T22:21:41.1Z         0.200s
check 2026-09-15T22:21:41.100000000Z 2026-09-15T22:21:41.100000000Z 0.000s
check garbage                        2026-09-15T22:21:41Z           unknown
rm -rf "$BIN"
[ "$failed" = 0 ] && echo "all BSD-branch cases correct"
exit "$failed"
