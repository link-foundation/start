#!/usr/bin/env bash
# Install the same pinned linter without an unauthenticated Docker Hub pull.
# The archive digest is pinned here: a checksums file fetched from the same
# release proves only that the download completed, not what was published.
set -euo pipefail

destination="${1:?usage: install-actionlint.sh destination-directory}"
download_dir=$(mktemp -d)
trap 'rm -rf "$download_dir"' EXIT
release=https://github.com/rhysd/actionlint/releases/download/v1.7.12
archive=actionlint_1.7.12_linux_amd64.tar.gz
sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
curl -fsSL --retry 3 "$release/$archive" -o "$download_dir/$archive"
echo "$sha256  $download_dir/$archive" | sha256sum --check --strict
mkdir -p "$destination"
tar -xzf "$download_dir/$archive" -C "$destination" actionlint
