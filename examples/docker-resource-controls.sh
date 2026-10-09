#!/bin/sh
# Finite, modest resource limits. Requires Docker memory/CPU controllers.
# Usage: START_CLI=start sh examples/docker-resource-controls.sh (Rust)
#        START_CLI='$' sh examples/docker-resource-controls.sh (JavaScript)
set -eu
resource_cli=${START_CLI:-\$}
"$resource_cli" -i docker --image alpine --memory 64m --cpus 1 -- 'echo bounded-container; sleep 2'
# A range is drawn once; 1% is deliberately small for this example.
"$resource_cli" -i docker --image alpine --memory '1%-2%' --cpus 1 -- 'echo randomized-container; sleep 2'
# Opt-in defaults: cap 2, trigger 95%/15m, release 65%/15m.
# $ -i docker -d --memory '90%-100%' --cpu-penalty -- my-task
# $ --resume <session> --memory 128m
