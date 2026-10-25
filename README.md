# Pi Subagent

> **Disclaimer:** This extension is vibe coded for personal use. Use at your own risk.

An opinionated personal [Pi](https://github.com/earendil-works/pi) extension for delegating focused work without growing the parent conversation into a second workspace.

**Fresh context by default. Explicit continuation when needed. Small handoffs. Visible execution state.**

This builds on Pi's subagent example, replacing subprocess-per-task execution with in-process SDK sessions and adding continuation validation, shared admission control, bounded output, and a guided implement/review workflow. It is not an official Pi component or a sandbox.

## Quick start

Requires **Pi 0.99.0+** (`@earendil-works` packages), **Node 24+**, Linux/macOS. Development dependencies pin **0.99.0**; newer versions are intended targets, not a guarantee against upstream API changes. Optional process/benchmark diagnostics require Linux.

Install from GitHub:

```bash
pi install git:github.com/shardrunner/pi-slim-subagent
```

Or, for development, from a clone of this repository:

```bash
npm ci
npm run check
pi install .
```

The explicit package manifest loads only `index.ts`, not tests or the smoke harness. Pi supplies the core peer dependencies at runtime. Do not also install a second copy in your extensions directory.

Create `~/.pi/agent/agents/` if needed, then copy the desired files from [`examples/agents/`](examples/agents/) into it. **Check for existing files first; do not overwrite your own agents.** Examples omit `model`, using your configured Pi default. To select a specific provider, add a `model: provider/model-id` line with an authenticated model from your installation.

Restart Pi or run `/reload`, then ask:

```text
Use explorer to identify the authentication entry points. Do not change files.
```

To try without recording a package installation:

```bash
pi -e ./index.ts
```

Once hosted, the same package can be installed with `pi install git:github.com/<owner>/<repo>@<tag>`.

## What it does

| Entry point                | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `load_subagents` tool      | Only tool loaded at startup; enables both dispatch tools on demand       |
| `subagent` tool            | One fresh, user-scoped dispatch with a compact schema (loaded on demand) |
| `subagent_advanced` tool   | Single, parallel, overrides, project agents, and continuation            |
| `/agents [run-id-prefix]`  | Inspect this instance's active runs without a model call (TUI/RPC)       |
| `/implement-review <task>` | Ask the parent to follow a bounded implement/review protocol             |

Only `load_subagents` is active at startup (plus a one-line prompt snippet so the model knows delegation exists). Calling it enables both dispatch tools and returns the agent catalog; the catalog is no longer embedded in an always-visible schema. Agent definitions are rediscovered on dispatch; `/reload` refreshes the advertised catalog. In `print`/JSON mode, UI-only commands do not provide interactive inspection.

On `session_start`, both dispatch tools stay hidden unless the branch history shows a prior loader call (via persisted `details.added`), so resume restores a previously loaded loadout without leaking schemas into fresh sessions. If compaction drops the loader record, the model simply calls `load_subagents` again (one cheap call).

All three orchestration tools use `model-only` exposure: the parent model calls them directly, including in codemode-only mode. They are not callable through codemode scripts or `ctx.executeTool()`, preserving the direct transcript records used for activation and continuations.

Advanced activation and “only when requested” instructions are **model guidance**, not an authorization boundary.

### Parallel work

```text
Run two explorers in parallel: one inspect authentication, one inspect session storage.
```

Advanced tool shapes:

```json
{
	"tasks": [
		{ "agent": "explorer", "task": "Inspect authentication" },
		{ "agent": "explorer", "task": "Inspect session storage" }
	]
}
```

### Explicit continuations

```json
{
	"agent": "implementor",
	"task": "Implement the requested change",
	"continuation": { "action": "create", "thread": "change" }
}
```

```json
{
	"agent": "implementor",
	"task": "Address these specific review findings ...",
	"continuation": { "action": "resume", "thread": "change" }
}
```

Continuations require a persisted parent session and are available only in top-level single mode. The parent branch records the last accepted child leaf. Resume verifies the parent, agent name/source/canonical definition path, working directory, child file, and session ancestry. An unsuccessful turn does not advance the accepted pointer.

**Conversation rollback is not filesystem rollback.** Failed or cancelled agents may already have changed files. Agent identity tracks the definition path, not a hash of its contents; editing that file changes the prompt used on a later resume.

Forked parent sessions cannot resume another parent's continuation. Navigate back within the same parent to resume its recorded branch state. Do not open the same parent session simultaneously in multiple Pi instances. Continuation exclusion is instance-local and lasts until actual settlement; cross-Pi continuation is unsupported.

## Agent configuration

```markdown
---
name: explorer
description: Read-only code reconnaissance
tools: [read, grep, find, ls]
# Optional: use a provider/model configured in your Pi installation
# model: provider/model-id:high
---

Inspect the requested scope and return concise, evidence-backed findings.
```

- User definitions: `~/.pi/agent/agents/*.md` (or `agents/` under `PI_CODING_AGENT_DIR`).
- Project definitions: nearest ancestor `<config-dir>/agents/*.md`; enabled only with `agentScope: "project"` or `"both"` in a trusted project.
- With `"both"`, valid project definitions override same-named user definitions. Duplicates within one directory keep the first definition in filename order.
- `name` is a bounded ASCII identifier; `description` is required.
- `tools` accepts a comma-separated string or YAML array of built-in tool names. **Omitted** means SDK defaults; **`[]`** means no tools. Unknown tool names are errors.
- `model` is optional. Omitted means SDK session/settings defaults, **not necessarily the parent's currently selected model**.
- A dispatch `thinkingLevel` overrides the model suffix; per-item values override top-level values.
- Unreadable or invalid definitions are skipped in both scopes; valid definitions remain available. Source-path warnings appear at startup, dispatch, and `/agents` (stderr without UI). A skipped project definition does not override a valid user definition. Parsing remains strict; project trust is still required.

## Limits and cancellation

| Boundary                    | Policy                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------- |
| Concurrent child sessions   | 4 shared across single dispatches and batches in a loaded extension module instance |
| Parallel batch              | At most 8 tasks                                                                     |
| Default task timeout        | 1500 seconds (25 minutes), including SDK setup after admission                      |
| Advanced timeout override   | Finite positive seconds, at most 7200                                               |
| Individual final handoff    | 24 KiB / 600 lines                                                                  |
| Combined parallel handoff   | 50 KiB / 2000 lines, preserving every agent's status and a fair output share        |
| Retained collector messages | Up to 32 messages / 64 KiB; SDK context management is separate                      |
| Run tail                    | 32 KiB / 200 lines in memory                                                        |

Queued work is cancellable; queue waiting is outside the per-task execution timeout. If all four slots are quarantined by unsettled work, queued and new tasks fail explicitly without starting. Slots remain reserved until actual cleanup; if some healthy capacity remains, queued work continues through it. These are instance-local limits, not a machine-wide compute quota or spending cap. Avoid concurrent builds and overlapping edits to the same files.

Cancellation is **cooperative**. At timeout or parent abort, the extension requests SDK abort and allows a short cleanup grace period (up to two 2-second waits for prompt and cleanup). If work remains unsettled, the tool returns a failure while retaining its concurrency slot, run tracking, and instance-local continuation lock until actual settlement. Late errors are diagnosed separately; already-returned results do not change.

This does not kill an uncooperative provider, shell descendant, or blocked event loop. Restart Pi if work never settles, inspect remaining OS processes, and verify the working tree before retrying. Reloading an extension is not a substitute for terminating old work. Use process/container isolation if hard termination is required.

Truncated fresh output is intentionally not saved as a full transcript. Ask for a narrower follow-up or have the agent write an explicitly requested artifact. Persistent continuations retain SDK session transcripts.

## Guided implement/review workflow

`/implement-review <task>` sends the parent a protocol with unique thread names:

1. Implement and commit; report the commit SHA and base.
2. Review the exact change, with diff and validation evidence supplied by the parent.
3. Resume the implementor once to address material findings and validate.
4. Optionally resume the reviewer once to verify corrections; report remaining issues instead of looping.

Both agents use the default 1500-second (25-minute) timeout. Focused checks precede a final broad gate.

**This is a prompted protocol, not an enforced state machine.** The parent model must follow the sequence and limits. The supplied reviewer has no shell or mutation tools. Granting it `bash` removes that capability restriction regardless of “read-only” wording.

## Security and persistence

Read [SECURITY.md](SECURITY.md) before using agents on sensitive repositories.

- Children share your OS permissions, environment, working tree, and configured provider credentials.
- Children deliberately load **no extensions and no skills**. Parent permission hooks, sandbox hooks, custom tools, and extension-only providers are not inherited.
- Project instructions/context are still loaded. Trusted project configuration can influence behavior.
- Tool traces record lifecycle metadata, not arguments/results or private reasoning. Assistant text and task previews can still contain secrets.
- Run snapshots/tails live only in the owning extension instance's memory; normal completion removes them. There are no registry files, heartbeat timers, or stale-owner checks. Reloaded instances cannot inspect retired instances' runs.
- Continuation transcripts live under `<agent-dir>/subagent-continuations/<parent-id-hash>/`. Parent session details retain continuation locators. Child transcripts may include full tool payloads and model reasoning.
- Continuation directories are private (`0700`). There is no automatic deletion policy for continuation transcripts.

### Recovery

1. Inspect `/agents` and the working tree. An absent run record does not prove all descendant processes have stopped, particularly after reload.
2. If a continuation is in use, wait for settlement or deliberately stop Pi and inspect its descendants. Do not reload to bypass ongoing work.
3. Preserve transcripts when investigating a failure. Remove unused continuation directories only when they are no longer referenced or needed. Old versions' run files and `.lock` files are no longer read; they are not automatically deleted.

Do not commit your agent directory, credentials, runtime snapshots, or session transcripts to this repository.

## Troubleshooting

| Symptom                                    | Check                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Available agents: none / unknown agent     | Copy a definition into `<agent-dir>/agents/`, check its `name`, then `/reload` to refresh the catalog.                                                                    |
| Missing workflow agent                     | `/implement-review` requires both `implementor` and `code-reviewer`; it checks before starting.                                                                           |
| Model unavailable / authentication failure | Use a model configured and authenticated in Pi settings or `models.json`. Parent extension-only providers and runtime-only credentials are not inherited.                 |
| Custom tool unavailable                    | Children deliberately expose built-ins only; remove extension tool names from the agent allowlist.                                                                        |
| Project trust / cwd rejection              | Trust the project through Pi; use its cwd or a permitted child directory rather than bypassing the check.                                                                 |
| Capacity quarantined after a timeout       | Unsettled work still owns all slots, so waiting tasks fail rather than hang. Inspect `/agents`; do not reload to bypass active work. See cancellation and recovery above. |
| Service initialization keeps failing       | Initialization is shared and cached, including failure. Correct configuration, then reload once old work is confirmed stopped.                                            |

## Development

```bash
npm ci
npm run check          # strict types, formatting, offline tests
npm run test:package   # pack, unpack, and load via the real Pi extension loader
npm run format
```

Tests include fake-session fault injection, behavioral tool registration/rendering, a real SDK fake-provider continuation round trip, instance-local continuation exclusion through settlement, and an unpacked-package load check. They do not need API credentials. CI tests Node 24 on Linux/macOS and Node 26 on Linux.

See [architecture](docs/architecture.md) for design trade-offs and [benchmarks](docs/benchmarks.md) for opt-in live diagnostics. No performance improvement is claimed without reproducible measurements.

## License

[MIT](LICENSE). Derived portions of Pi's subagent example retain their original notice; see [NOTICE](NOTICE).
