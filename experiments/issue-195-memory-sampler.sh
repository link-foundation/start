#!/bin/sh
# A finite remote/dind fixture shared by the JS and Rust regression suites.
set -eu
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
mkdir "$fixture_dir/bin"
export START_SAMPLER_FIXTURE="$fixture_dir" START_SAMPLER_MODE="$1"
export START_COMMAND_CGROUP_ROOT="$fixture_dir/hidden" START_COMMAND_PROC_ROOT="$fixture_dir/hidden"
export TMPDIR="$fixture_dir" PATH="$fixture_dir/bin:$PATH"
cat > "$fixture_dir/bin/docker" <<'DOCKER'
#!/bin/sh
case "$1" in
  inspect)
    case "$3" in
      *HostConfig.Memory*) echo 67108864;;
      *CgroupnsMode*) if [ "$START_SAMPLER_MODE" = shared ]; then echo host; else echo private; fi;;
      *State.Pid*) echo 0;;
      *State.Running*) echo true;;
      *Id*) printf '%064d\n' 195;;
    esac;;
  exec)
    case "$START_SAMPLER_MODE" in
      no-shell) echo "sh: not found" >&2; exit 127;;
      outage) if [ -f "$START_SAMPLER_FIXTURE/sampled" ]; then exit 1; fi;;
    esac
    touch "$START_SAMPLER_FIXTURE/sampled"
    echo '67108864 33554432 1 3 /sys/fs/cgroup';;
esac
DOCKER
chmod +x "$fixture_dir/bin/docker"
# $2 defines the sampler under test, stops it, and prints its diagnostic line.
sh "$2"
