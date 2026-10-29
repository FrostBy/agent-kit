# Native Codex footer experiment

The feature patches in [`codex-0.164.0/manifest.json`](codex-0.164.0/manifest.json) target the official OpenAI Codex tag `rust-v0.164.0`.
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

## Prerequisites / Требования

Windows x64, Node.js 20+, Git, [rustup](https://rustup.rs/) and Visual Studio MSVC C++ Build Tools (including the Windows SDK). Codex's `rust-toolchain.toml` selects Rust 1.99.1. If rustup is absent, the build accepts cargo from PATH with a warning; that toolchain must be compatible. MSVC is discovered through cl/link or vswhere. Missing tools produce an actionable error, including the Build Tools winget command.

Windows x64, Node.js 20+, Git, rustup и MSVC C++ Build Tools с Windows SDK. Версию Rust 1.99.1 задаёт исходный Codex. Без rustup допустим совместимый cargo из PATH с предупреждением. macOS/Linux build/install are explicit TODOs and stop with an error; source preparation and patch verification use portable Node code.

Only source patches are distributed; build the binary locally. Installation requires an existing official standalone package with a `current` junction and matching 0.164.0 voice/resources. No npm dependencies are required.

## Build and install / Сборка и установка

```sh
npm run codex:prepare
npm run codex:build
# Or choose features; dependencies are included automatically:
npm run codex:build -- --features statusline,full-diff,interaction-modes
npm run codex:install
npm run codex:sync-footer
npm run codex:restore
```

`prepare` downloads the pinned GitHub tag archive only when missing, verifies SHA-256 and the ZIP comment commit, and extracts clean sources into `.native/work/<version>-<feature-hash>`. It never changes `.native/codex`. `build` prepares again, applies patches in manifest order, and runs cargo with `.native/target` as `CARGO_TARGET_DIR`; release is the default, `--dev` selects debug. `--features none` builds upstream without patches; omitted `--features` selects all. Existing recognized work directories for the same selection are recreated; other directories for this version with our valid source marker are removed best effort after preparation. Foreign directories and other versions are untouched; do not edit generated sources.

Both `STABLE_GIT_COMMIT` and `CODEX_BUILD_COMMIT` are set to `6aaac694803004a63c6f393d153c96d22521a6b9`, the archive commit. Without this stamp, the bundled voice component rejects the `dev` build handshake. The official package's voice host must have the same build commit.

`install` copies the stock package once into the stable sibling release `<version>-agent-kit`, replaces `bin/codex.exe`, and copies `statusline.js`, `package.json`, `LICENSE`, and `src/` into `codex-resources/agent-statusline`. Executable and footer copies are hash-verified. With existing state, reinstall updates the same `customTarget` in place without copying the package again. A locked executable is renamed to `.retired-*` before copying; the footer directory is staged and replaced with rollback on rename failure. Config, auth and terminal settings are untouched. The latest three state backups are retained under standalone. `restore` checks the stock hash and refuses an unexpected active release. `sync-footer` uses the same footer replacement and removes its previous directory after success. Retired executables and staging/previous directories are cleaned up best effort; locked leftovers are silently skipped and retried on later operations.

Without state, a release containing `codex-resources/agent-statusline` or lacking an official version/target-triple name is treated as custom. Migration first searches the targets of `current.before-*` junctions, then `releases/<version>-x86_64-pc-windows-msvc`. A package with our footer is never accepted as stock. If no stock release is found, installation stops with a clear error. The old manual custom release is not deleted: installation prints its path and a reminder to remove it manually only after checking the new installation and closing old processes.

Junction activation uses two renames with rollback on errors (as in the former PowerShell installer); there is a brief interval without `current`. A process/power failure between these renames requires recovery from the `current.before-*` junction, which is cleaned up only after successful activation and saving state. Reinstalling an already active custom release does not switch the junction.

Установка один раз копирует штатный пакет в `<version>-agent-kit`; повторная обновляет тот же `customTarget` на месте, переименовывая занятый exe. При миграции штатный релиз ищется через `current.before-*`, затем по стандартному имени; старый кастомный каталог остаётся для ручного удаления после проверки. `restore` возвращает штатный релиз, `sync-footer` заменяет только футер и удаляет предыдущую копию. Хранятся последние три бэкапа состояния; хвосты удаляются по возможности, занятые пропускаются. `prepare` очищает другие каталоги этой версии только с нашим маркером. Настройки и авторизация не меняются. Между двумя переименованиями junction есть короткий разрыв; при аварии восстанавливайте `current` из `current.before-*`.

Paths (CLI options take precedence over environment):

| Option | Environment | Default |
|---|---|---|
| `--native-dir` | `CODEX_NATIVE_DIR` | repository `.native` |
| `--codex-home` | `CODEX_HOME` | `~/.codex` |
| `--standalone` | `CODEX_STANDALONE_DIR` | `<CODEX_HOME>/packages/standalone` |
| `--binary` | `CODEX_NATIVE_BINARY` | last successful build for install; `.native/target/<profile>/codex.exe` for build |
| `--footer-root` | `CODEX_FOOTER_ROOT` | repository root |

For a disposable install, use `npm run codex:install -- --codex-home <temporary-home> --binary <fake-exe>` after creating a fake standalone stock release and `current` junction. `CARGO_HOME` and PATH are inherited; no toolchain is installed by these scripts.

## Feature manifest

The manifest is the source of feature IDs, English/Russian descriptions, ordering and attribution. Independent features share no edited files; interaction modes deliberately depends on statusline for its payload and refresh state.

| ID / patch file in `codex-0.164.0/` | Dependencies | Description / Описание |
|---|---|---|
| `statusline.patch` | — | Native footer / нативный футер, payload, max_lines 32, hidden Plan indicator, config tests |
| `full-diff.patch` | — | Full compact diffs / полные компактные диффы (booxter) |
| `exec-timing.patch` | — | Elapsed time and live line counts / время и строки вывода |
| `capacity-retry.patch` | — | Capacity backoff and stream retry limit 10 / повторы (booxter) |
| `interaction-modes.patch` | statusline | Plan ↔ Auto, Windows Shift+Tab, payload mode, combined permission update |
| `restricted-subagents.patch` | — | Spawn `mode: plan\|read_only` / ограниченные сабагенты |

```sh
npm test
node scripts/codex/verify-patches.js
```

The explicit verification command needs the cached source archive. It tests all 48 valid feature combinations with `git -c core.longpaths=true apply --check` and application in a disposable clean tree, then checks the full selection against `tree-sha256.json`, recorded from the former combined patch. The initial split also compared all 9454 tree files byte-for-byte with that patch. Node tests cover manifest/dependency errors, paths, mocked requirements and Windows install/reinstall/sync/restore with fake executables and real junctions. They never launch Codex or access a real account.

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
