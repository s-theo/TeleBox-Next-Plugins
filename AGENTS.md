# AGENTS.md - TeleBox-Next Plugins

Applies to the entire repository. There are no nested instruction files.

## Scope and layout

This repository contains Theo's custom plugins for TeleBox-Next only. Classic TeleBox plugins live in `s-theo/TeleBox-Plugins` and must not be mixed into this repository.

- Each plugin lives at `<name>/<name>.ts`.
- `plugins.json` is the public install index. Its keys, paths and descriptions must match the plugin directories and use this repository's `main` branch.
- Keep `README.md`, `plugins.json` and the plugin directories aligned when adding, renaming or removing a plugin.

## Host contract

The plugins run inside TeleBox-Next rather than as standalone Node programs. The host provides `@utils/*`, `@mtcute/*`, its loader, runtime client, asset paths and runtime libraries. Do not add local shims or dependencies solely to satisfy standalone resolution.

Next plugins use mtcute APIs such as `MessageContext`, `@mtcute/node` and `msg.chat.id`. Do not reintroduce `teleproto`, `Api.Message`, `Api.*` or other Classic APIs.

Preserve the existing default-exported `Plugin` instance, commands, configuration formats, public endpoints, HTML escaping and asset paths unless the task targets them. Keep `setup()` and `cleanup()` lifecycle behavior idempotent, honor abort/generation state, and release only resources owned by the plugin; never dispose of host-owned clients.

## Toolchain and checks

Read the Node, package-manager and Biome versions from `.nvmrc`, `package.json`, `pnpm-lock.yaml` and `biome.json` instead of recording version snapshots here.

```sh
pnpm install --frozen-lockfile
pnpm run format:check
git diff --check
```

Use `pnpm run format` only when formatting and organize-import changes are intended, then review the full diff. Biome provides static TypeScript/JSON checks only; this repository has no TeleBox-Next build, typecheck or runtime-test harness. Do not add Prettier or claim host-level validation.

Do not execute plugin handlers as local tests: they can access external services, run local binaries, upload media or delete Telegram messages. Runtime validation requires an explicitly authorized TeleBox-Next instance.

Never commit API keys, tokens, Telegram sessions, generated media, runtime databases or cached assets. Verify that every indexed URL points to an existing `main/<name>/<name>.ts` file.

## Git safety

Before editing, inspect the branch/upstream, worktree, index, untracked files, stashes and in-progress Git operations. Preserve unrelated work; do not stash, reset, clean, rebase or rewrite history without explicit authorization.

Commit, push, pull request, merge, release and branch deletion are separate external actions requiring Theo's authorization. Before handoff, confirm the exact changed-file set, run the applicable checks and prove local/remote SHA parity after any authorized push.
