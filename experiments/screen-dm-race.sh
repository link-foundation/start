#!/bin/sh
# Does `screen -dmS` return before the session is listed by `screen -ls`?
# Starts N short sessions (optionally under CPU load) and counts how often
# the very first `screen -ls` after `screen -dmS` misses the session.
# Usage: [N=200] [LOAD=0] sh experiments/screen-dm-race.sh
n="${N:-200}"; load="${LOAD:-0}"; pids=""
i=0; while [ "$i" -lt "$load" ]; do timeout 300 sh -c 'while :; do :; done' & pids="$pids $!"; i=$((i+1)); done
missed=0; i=0
while [ "$i" -lt "$n" ]; do
  name="race-$$-$i"
  screen -dmS "$name" sh -c 'sleep 1'
  screen -ls | grep -q "$name" || missed=$((missed+1))
  i=$((i+1))
done
[ -z "$pids" ] || kill $pids 2>/dev/null
echo "missed=$missed of $n (load=$load)"
screen -ls | grep -o "race-$$-[0-9]*" | while read -r s; do screen -S "$s" -X quit; done
