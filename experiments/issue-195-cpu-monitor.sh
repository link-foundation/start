#!/bin/sh
# Finite Docker fixture: two busy windows, separated by a quiet window.
set -eu
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
mkdir "$fixture_dir/bin"
export START_CPU_FIXTURE="$fixture_dir" START_DOCKER_BIN="$fixture_dir/bin/docker"
export START_APP_FOLDER="$fixture_dir/unused-store" START_DISABLE_TRACKING=true
cat > "$START_DOCKER_BIN" <<'DOCKER'
#!/bin/sh
set -eu
step_file="$START_CPU_FIXTURE/step"
case "$1" in
  inspect)
    step=0
    if [ -f "$step_file" ]; then step=$(cat "$step_file"); fi
    step=$((step + 1))
    echo "$step" > "$step_file"
    if [ "$step" -gt 36 ]; then echo false; else echo true; fi;;
  info) echo '{"NCPU":6,"MemTotal":1073741824}';;
  stats)
    # Passing a possibly missing container name would break this request.
    [ "$#" -eq 4 ]
    step=$(cat "$step_file")
    if [ "$step" -le 12 ] || [ "$step" -gt 24 ]; then cpu=600.00; else cpu=20.00; fi
    echo '{"Name":"unrelated","CPUPerc":"900.00%"}'
    printf '{"Name":"cpu-task","CPUPerc":"%s%%"}\n' "$cpu";;
  update)
    [ "$4" = cpu-task ]
    [ "$3" != 0 ]
    printf '%s\n' "$3" >> "$START_CPU_FIXTURE/updates";;
  *) exit 1;;
esac
DOCKER
chmod +x "$START_DOCKER_BIN"
"$@"
# Untracked CPU monitoring must not create or write an execution store.
[ ! -e "$START_APP_FOLDER" ]
[ "$(wc -l < "$fixture_dir/updates" | tr -d ' ')" -eq 3 ]
[ "$(sed -n '1p' "$fixture_dir/updates")" = 2 ]
[ "$(sed -n '2p' "$fixture_dir/updates")" = 6 ]
[ "$(sed -n '3p' "$fixture_dir/updates")" = 2 ]
