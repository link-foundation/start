#!/usr/bin/env bash
# Issue #253: probe how the installed clink handles every query shape the
# execution store sends (create, update, verify, delete), first the shapes of
# start-command <= 0.39.2, then the record-scoped schema that replaced them.
# Each run uses a fresh directory: clink keeps names in a sibling
# <db>.names.links file, and a stale one from an earlier run corrupts results.
# Usage: experiments/issue-253/clink-queries.sh [clink-binary]
set -u
CLINK="${1:-clink}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
"$CLINK" --version
run() {
  local db="$1" title="$2"
  shift 2
  echo "### $title"
  "$CLINK" "$@" --db "$DIR/$db.links" 2>&1 | tail -n 20
  echo "exit: ${PIPESTATUS[0]}"
}
AUTO=--auto-create-missing-references
U=9d6d33e1-ac5b-402f-9699-cc650386d835
V=7082d164-763f-494f-a04b-0f372e49f96f

echo "## start-command <= 0.39.2"
run old "nested groups, no $AUTO" "() ((($U: ExecutionRecord $U)) (($U.status: status \"executing\")))"
run old "backslash-escaped JSON value" "() (($U.options: options \"{\\\"a\\\":1}\"))" $AUTO
run old "quoted number is read as a link address" "() (($U.exitCode: exitCode \"0\"))" $AUTO
run old "shared (status executing) link: second record takes the name" \
  "() (($U.status: status executing) ($V.status: status executing))" $AUTO --changes
run old "state" "" --after

echo "## record-scoped schema"
run new "create" "() (($U: ExecutionRecord $U) ($U.status: $U \"status=executing\") ($U.options: $U \"options={\"\"a\"\":1}\") ($U.exitCode: $U \"exitCode=0\"))" $AUTO --changes
run new "second record with the same values" "() (($V: ExecutionRecord $V) ($V.status: $V \"status=executing\") ($V.options: $V \"options={\"\"a\"\":1}\"))" $AUTO
run new "update, step 1: drop the property links" "((\$id: $U \$value)) ()" --changes
run new "update, step 2: create the new ones" "() (($U: ExecutionRecord $U) ($U.status: $U \"status=executed\") ($U.exitCode: $U \"exitCode=3\"))" $AUTO
run new "verify query" '((($id: ExecutionRecord $uuid)) (($id: ExecutionRecord $uuid)))' --changes
run new "delete: property links, then the record link" "((\$id: $U \$value)) ()"
run new "delete record link" "(($U: ExecutionRecord $U)) ()"
run new "state" "" --after
