# Native Codex footer experiment

`codex-0.164.0-statusline.patch` targets the official OpenAI Codex tag `rust-v0.164.0`.
It is based on [GordonBeeming/codex-statusline](https://github.com/GordonBeeming/codex-statusline), patch version 5, ported from Codex 0.163.0.
The native patch is covered by [Apache-2.0](LICENSE.Apache-2.0); upstream notices are preserved in [NOTICE](NOTICE).

Source archive: <https://codeload.github.com/openai/codex/zip/refs/tags/rust-v0.164.0>

SHA-256: `9c26a6a226a7b96bc9086225e5efc8b6db1192bc9929224cb93eb5a868508155`.
The original third-party patch SHA-256 is `b04618aafb098cced02a530313d66cc65edd12836ecb9d00cf14b650390b84e3`.

The port preserves the original project directory for umbrella scans, exports exact last-request context tokens and cumulative reasoning tokens, and adds Windows command/timeout tests. Unavailable cache-write usage is omitted.

## What the patch adds

Alongside the native command-backed footer, the Codex 0.164.0 patch includes:

1. Full edit diffs in compact mode (`tui/src/history_cell/patches.rs`). Idea and original patch: [booxter/nix](https://github.com/booxter/nix), `patches/codex-show-full-patches.patch`.
2. Command elapsed time and completed live-output line counts (`tui/src/exec_cell`): `• Running cmd · 10s · 2 lines`, then `• Ran cmd · 11s`.
3. Retries for server overload without `Retry-After`, with a 5–60-second backoff, and a default stream retry limit of 10 instead of 5 (`core/src/responses_retry.rs`, `model-provider-info`). Ideas and original patches: [booxter/nix](https://github.com/booxter/nix), `codex-capacity-retry.patch` and `codex-stream-retry-limit.patch`.
4. Shift+Tab toggles Plan ↔ Auto (Full Access) without a confirmation modal while idle, including Windows terminals reporting Tab+Shift. The built-in Plan indicator is hidden when the custom footer is active; the JSON payload carries `mode`, and our renderer places the mode line last with spacing before it.
5. Subagent `multi_agents` v2 spawn accepts `mode: plan|read_only` to restrict the child, never to escalate permissions.
6. Codex's status-line `max_lines` defaults to 32 as a safety ceiling; the footer's `maxLines` option controls its actual content row budget.

## Build

Use Rust 1.99.1 and the Visual Studio C++ build tools for x86_64 Windows MSVC. Extract the source into `.native/codex`, then run from this checkout:

```powershell
git -C .native/codex init
git -c core.longpaths=true -C .native/codex apply ../../patches/codex-0.164.0-statusline.patch
$env:CARGO_TARGET_DIR = "$PWD/.native/target"
$env:CARGO_HOME = "$PWD/.native/cargo"
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_PROFILE_DEV_INCREMENTAL = 'false'
$env:STABLE_GIT_COMMIT = '6aaac694803004a63c6f393d153c96d22521a6b9'
$env:CODEX_BUILD_COMMIT = '6aaac694803004a63c6f393d153c96d22521a6b9'
Push-Location .native/codex/codex-rs
try { cargo build -p codex-cli --bin codex } finally { Pop-Location }
```

This is the commit of the codex-0.164.0 source archive, visible in the ZIP comment; without it, the build gets the `dev` identifier and the bundled voice component (`codex-resources/voice/bin/codex-voice-host.exe`) rejects the handshake, so voice does not work in Codex. Check that `codex-voice-host.exe --build-commit` matches this value.

The release archive contains workspace package versions stamped as `0.0.0` in Cargo.lock; Cargo updates those to `0.164.0`. External dependency versions do not change.
The upstream Codex test `status_snapshot_shows_auto_review_permissions` expects `v0.0.0` in the header and fails with this build recipe because Cargo stamps `0.164.0`; this version mismatch is unrelated to the patch.
The prepared local toolchain lives in `.native/toolchain/bin`; it was extracted without installing Rust globally.

## Faster voice (configuration only)

In `~/.codex/config.toml`, set `experimental_realtime_ws_backend_prompt` to the full contents of the stock `prompts/templates/realtime/backend_prompt.md`, replacing `{{ user_first_name }}` with the user's first name and appending a sentence such as "Speak at a faster pace." Codex sends this override verbatim, so regenerate it from the stock template after updating Codex. This is a configuration change, not part of the patch.

Idea: [booxter/nix](https://github.com/booxter/nix), `hm/_mixins/dev/agents/codex/default.nix`.

## Isolated Windows test

```powershell
node scripts/native-codex.js
node scripts/native-codex.js Z:/work
```

This starts `.native/target/debug/codex.exe` with `.native/test-home` as CODEX_HOME, an unauthenticated loopback provider, and one-shot footer settings. It cannot make model requests to your account. If Windows offers sandbox setup, press Esc to inspect the footer without installing anything.
The installed Codex executable, user config, terminal profiles and PATH are not edited by the launcher.

The custom CLI runs `node statusline.js --codex-native` internally, passing a JSON snapshot on stdin and rendering its ANSI stdout inside the native footer. This entry point is not a separate terminal panel.
Snapshot data includes model, effort, context, quota windows, active tool names and details, plan progress, reported subagent states, fast mode and already-cached PR metadata. Tool completion and turn interruption clear active calls; agent status notifications update the running count. Git comes from the shared local scanner.

The renderer preserves the original Claude layout, colors, gap and Git defaults. It omits the added M/D/S counters, cumulative-token row and quota prefix. Terminal height determines the row budget; the command runner has a 32-line safety cap. Git rendering retains totals for the whole umbrella and reports hidden repositories. Missing exact context counts are omitted rather than reconstructed from rounded percentages.

Unavailable Claude-specific billing, daily spend and cache-expiry fields remain hidden. PR number and URL are passed through only when already known to the CLI; this patch does not query GitHub for missing PR data or review state. ANSI hyperlinks are not passed through the command-output sanitizer.

Agent attention is shown beside the running count: approval requests, user-input requests and failures include the agent nickname or path. Normal work clears waiting indicators. Failures remain through idle notifications until a retry, successful completion or close. Unrelated threads are excluded. Only the first issue is shown, with a count for additional issues; a narrow terminal gets one temporary alert row instead of clipped text. Healthy agents add no rows or zero counters.

Validated: 30 Node tests, including rendered-output equivalence with Claude, localization, attention severity and terminal budgets; 9 native Windows command/payload/activity tests, including waiting/failure/recovery transitions and names. The packaged CLI starts, parses its footer config and runs the packaged renderer. Earlier checks covered colored CLI rendering, footer layout and live Git refresh.
Live account quotas and model requests were not exercised by the isolated profile.
