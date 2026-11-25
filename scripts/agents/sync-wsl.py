#!/usr/bin/env python3
"""Run Claude's sync hook on the Windows side of WSL."""
import json
import os
from pathlib import Path
import subprocess
import sys


def windows_path(value):
    return subprocess.check_output(['wslpath', '-w', value], text=True).rstrip('\n')


def interactive_claude():
    pid = os.getppid()
    identity = None
    while pid > 1:
        proc = Path('/proc') / str(pid)
        args = proc.joinpath('cmdline').read_bytes().split(b'\0')
        fields = proc.joinpath('stat').read_text().rsplit(')', 1)[1].split()
        if Path(os.fsdecode(args[0])).name == 'claude':
            if any(arg == b'-p' or arg.split(b'=', 1)[0] == b'--print' for arg in args[1:]):
                return None
            identity = identity or f'wsl:{pid}:{fields[19]}'
        pid = int(fields[1])
    return identity


def main():
    if os.getenv('SESSION_SYNC_EXCLUDE') or os.getenv('SESSION_SYNC_BROKER'):
        return 0
    event = json.load(sys.stdin.buffer)
    if not all(event.get(key) for key in ('cwd', 'transcript_path', 'session_id')):
        return 0
    identity = interactive_claude()
    if not identity:
        return 0
    for key in ('cwd', 'transcript_path'):
        event[key] = windows_path(os.path.realpath(event[key]))
    env = os.environ.copy()
    profile = env.get('SESSION_SYNC_WINDOWS_CLAUDE_DIR') or env.get('CLAUDE_CONFIG_DIR') or str(Path.home() / '.claude')
    env['CLAUDE_CONFIG_DIR'] = windows_path(profile)
    keys = ['CLAUDE_CONFIG_DIR']
    if env.get('CODEX_HOME', '').startswith('/'):
        env['CODEX_HOME'] = windows_path(env['CODEX_HOME'])
        keys.append('CODEX_HOME')
    if env.get('SESSION_SYNC_CONTEXT_TOKENS'):
        keys.append('SESSION_SYNC_CONTEXT_TOKENS')
    entries = [entry for entry in env.get('WSLENV', '').split(':') if entry and entry.split('/')[0] not in keys]
    env['WSLENV'] = ':'.join([*entries, *(key + '/w' for key in keys)])
    script = windows_path(str(Path(__file__).with_name('sync.js').absolute()))
    return subprocess.run([sys.argv[1], script, 'hook', 'claude', identity],
                          env=env, input=json.dumps(event).encode()).returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f'session-sync (WSL): {error}')
