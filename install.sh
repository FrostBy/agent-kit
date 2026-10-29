#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install it from https://nodejs.org/" >&2
  exit 1
fi
exec node "$(dirname "$0")/install.js" "$@"
