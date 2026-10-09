#!/usr/bin/env bash
# Install the same pinned linter without an unauthenticated Docker Hub pull.
set -euo pipefail

destination="${1:?usage: install-actionlint.sh destination-directory}"
download_dir=$(mktemp -d)
trap 'rm -rf "$download_dir"' EXIT
release=https://github.com/rhysd/actionlint/releases/download/v1.7.7
archive=actionlint_1.7.7_linux_amd64.tar.gz
checksums=actionlint_1.7.7_checksums.txt
curl -fsSL "$release/$archive" -o "$download_dir/$archive"
curl -fsSL "$release/$checksums" -o "$download_dir/$checksums"
(cd "$download_dir" && sha256sum --check --ignore-missing "$checksums")
mkdir -p "$destination"
tar -xzf "$download_dir/$archive" -C "$destination" actionlint
