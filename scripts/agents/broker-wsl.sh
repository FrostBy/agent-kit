#!/usr/bin/env bash
set -euo pipefail

windows_path() {
  if [[ $1 =~ ^[a-zA-Z]:[\\/] || $1 == \\* ]]; then
    printf '%s\n' "$1"
  else
    wslpath -a -w "$1"
  fi
}

script_dir=$(dirname "$(readlink -f "$0")")
args=()
while (($#)); do
  case $1 in
    --state|--cwd|--prompt|--message|--file|--image|--claude-config-dir)
      (($# > 1)) || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
      args+=("$1" "$(windows_path "$2")")
      shift 2
      ;;
    *)
      args+=("$1")
      # Keep arbitrary text out of the flag parser.
      if [[ $1 == --text ]] && (($# > 1)); then args+=("$2"); shift; fi
      shift
      ;;
  esac
done
export CLAUDE_CONFIG_DIR="$(windows_path "${SESSION_SYNC_WINDOWS_CLAUDE_DIR:?Set the Windows-side Claude profile}")"
export AGENT_KIT_WSL_BROKER=1
export WSLENV="${WSLENV:+$WSLENV:}CLAUDE_CONFIG_DIR/w:AGENT_KIT_WSL_BROKER/w"
exec "${AGENT_KIT_WINDOWS_NODE:?Set the WSL path to Windows node.exe}" "$(windows_path "$script_dir/broker.js")" "${args[@]}"
