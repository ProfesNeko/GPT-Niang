# Windows desktop usage fork

This branch is based on upstream GPT-Niang 1.3.5. Its Windows quota worker reads
the account usage returned by the already-running Codex desktop application.
It does not launch `codex app-server`, start a conversation, call a model, or
read authentication tokens. The existing Windows character library, settings,
quota display and refresh queue are retained.

## Data path

The worker discovers the running application's `codex-app-tools-*` Windows named
pipe. It uses the same length-prefixed JSON-RPC framing as the bundled Codex app
tools client, discovers `get_usage_limits` through `tools/list`, and calls only
that read-only tool. The application supplies `rateLimitsByLimitId`, the legacy
`rateLimits` view, and account identity. The worker persists a fingerprint of the
account identity, percentages and reset times; it does not persist the raw reply.

The bridge is an internal Codex desktop interface, not a stable public API.
It was tested against Codex desktop 26.1021 / CLI 0.164.0-alpha.11.1 on Windows.
An app update can change this interface. Failures are displayed as unavailable;
there is no fallback that launches a second Codex process.

## Install and upgrade

Use this branch as a Git checkout. Run the existing Windows installer from an
active Codex task so `CODEX_THREAD_ID` is available. The installer saves that
conversation ID as `desktopThreadId` in the local, ignored `installation.json`.
Upgrades preserve an existing binding. This context routes the app tool call;
the limits are for the currently signed-in desktop account, not that conversation.
The implementation does not read or write conversation content.

Codex desktop must be running. Windows pipe discovery runs on each refresh so
restarting the desktop app does not pin the worker to an obsolete pipe name.
If the bound conversation is removed, run the installer from another active
Codex task to replace the binding.

The normal updater already refuses to replace Git source checkouts with official
release archives. Update this branch with Git to retain the desktop reader.
Keep existing user preferences in the application's state directory.

This branch currently targets Windows desktop use. The named-pipe discovery
does not provide a standalone macOS backend. Upstream remains the source of the
unmodified cross-platform releases.

## Verification

Run `node --test gpt-niang-usage/tests/*.test.mjs`. Desktop transport tests cover
split frames, host failures, account changes and missing desktop connections.
The quota reader has no child-process dependency. Live validation should compare
the widget snapshot with the running desktop's usage response and observe Codex
process creation across manual refresh, automatic refresh and worker restart.
