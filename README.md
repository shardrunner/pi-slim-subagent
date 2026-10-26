# pi-slim-subagent

> **Disclaimer:** This extension is vibe coded for personal use. Use at your own risk.

Hand focused tasks to subagents in fresh [Pi](https://pi.dev) contexts and get back a
short result, instead of filling the main conversation with every intermediate step.

**Fresh context by default. Explicit continuation when needed. Small handoffs. Visible execution state.**

This builds on Pi's subagent example. Instead of starting a separate process per task,
it runs SDK sessions inside the Pi process, and it adds checked continuations, a shared
concurrency limit, size-limited output and a guided implement/review workflow. It is not
an official Pi component and not a sandbox.

## Why

- Long exploration or implementation work fills the main conversation with intermediate tool output, which raises cost and pushes important context out.
- Parallel subagents need firm limits on concurrency and output size, or they flood the context and compete for resources.

## Features

- **Loaded on demand:** at startup the model only sees a small `load_subagents` tool.
  The dispatch tools and agent list are loaded when they are first needed.
- **Single and parallel runs**, with at most 4 subagents running at once across the
  whole Pi instance.
- **Explicit continuations:** a later task can resume the same subagent conversation.
  Before resuming, the extension checks that the agent, working directory and session
  history still match.
- **Size-limited handoffs** so subagent output can't flood the main context.
- **Cooperative cancellation and recovery:** work that hasn't finished keeps its slot
  instead of quietly freeing it.
- **`/implement-review`**: a guided implement → review → fix workflow.

## Installation

Requires **Pi 0.99.0+** (`@earendil-works` packages) and **Node.js 24+** on Linux or macOS. The optional
process and benchmark diagnostics need Linux.

```sh
pi install git:github.com/shardrunner/pi-slim-subagent
```

Run `/reload` in open Pi sessions. Update with `pi update --extensions`.
For local development, run `npm ci && npm run check && pi install .` from a clone, or
try it once with `pi -e ./index.ts`. The package manifest only loads `index.ts`. Don't
also put a copy in your extensions directory.

Then create `~/.pi/agent/agents/` if needed and copy the agents you want from
[`examples/agents/`](examples/agents/). **Check for existing files first so you don't
overwrite your own agents.** The examples have no `model` line, so they use your default
Pi model.

## Usage

```text
Use explorer to identify the authentication entry points. Do not change files.
Run two explorers in parallel: one inspect authentication, one inspect session storage.
```

| Entry point                | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `load_subagents` tool      | The only tool loaded at startup; turns on both dispatch tools when needed |
| `subagent` tool            | Run one fresh subagent from your user agents (simple input schema)        |
| `subagent_advanced` tool   | Parallel runs, overrides, project agents and continuations                |
| `/agents [run-id-prefix]`  | Show this instance's active runs without a model call (TUI/RPC)           |
| `/implement-review <task>` | Ask the main agent to follow a fixed implement/review sequence            |

When a session is resumed, the dispatch tools come back only if the branch history shows
they were loaded before. If compaction dropped that record, the model calls
`load_subagents` again. The orchestration tools can only be called directly by the
model, not from codemode scripts or `ctx.executeTool()`. Instructions such as "only use
advanced mode when asked" are **guidance for the model, not permissions**.

### Parallel and continued runs

```json
{
	"tasks": [
		{ "agent": "explorer", "task": "Inspect authentication" },
		{ "agent": "explorer", "task": "Inspect session storage" }
	]
}
```

```json
{
	"agent": "implementor",
	"task": "Implement the requested change",
	"continuation": { "action": "create", "thread": "change" }
}
```

Continue the same thread later with `"action": "resume"`. Continuations need a saved
main session and only work for single (non-parallel) runs. Before resuming, the
extension checks the main session, the agent's name, source and definition path, the
working directory, the subagent's session file and its history. A failed turn doesn't
move the thread forward.

**Rolling back the conversation doesn't roll back files.** A failed or cancelled agent
may already have changed them. An agent is identified by its definition path, not by
its content, so editing that file changes the prompt used on the next resume. A forked
session can't resume another session's continuation. Don't open the same session in
several Pi instances at once.

### Guided implement/review workflow

`/implement-review <task>` gives the main agent a fixed sequence:

1. Implement and commit; report the commit SHA and base.
2. Review the change, using the diff and validation results the main agent provides.
3. Resume the implementor once to fix important findings and validate.
4. Optionally resume the reviewer once to check the fixes; report what is left instead
   of looping.

**This is a prompt the model follows, not an enforced workflow.** The included reviewer
agent has no shell or editing tools. If you give it `bash`, that restriction is gone,
whatever its prompt says.

## Configuration

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

- **User agents** live in `~/.pi/agent/agents/*.md` (or `agents/` under
  `PI_CODING_AGENT_DIR`). **Project agents** live in the nearest
  `<config-dir>/agents/*.md` and are only used with `agentScope: "project"` or `"both"`
  in a trusted project. With `"both"`, a project agent overrides a user agent of the
  same name.
- `name` is a short ASCII identifier, and `description` is required.
- `tools` is a list of built-in tool names. **Leaving it out** gives the SDK defaults;
  **`[]`** gives no tools. Unknown names cause an error.
- If `model` is left out, the SDK default is used, which **isn't necessarily the model
  selected in the main session**. A `thinkingLevel` given at dispatch overrides the
  model suffix.
- Invalid definitions are skipped with a warning naming the file; valid ones still load.

## Behavior and limitations

### Limits and cancellation

| Limit                       | Value                                                                          |
| --------------------------- | ------------------------------------------------------------------------------ |
| Subagents running at once   | 4, shared by single and parallel runs in one Pi instance                       |
| Parallel tasks              | At most 8 per run                                                              |
| Default task timeout        | 1500 s (25 min), including SDK setup                                           |
| Timeout override (advanced) | Up to 7200 s                                                                   |
| Single handoff              | 24 KiB / 600 lines                                                             |
| Combined parallel handoff   | 50 KiB / 2000 lines; every agent's status is kept, plus a fair share of output |
| Messages kept per subagent  | Up to 32 messages / 64 KiB                                                     |
| Run tail                    | 32 KiB / 200 lines in memory                                                   |

Queued tasks can be cancelled, and time spent waiting in the queue doesn't count toward
the timeout. These limits apply per Pi instance; they are not a machine-wide quota or a
spending cap.

Cancellation is **cooperative**. On a timeout or when you abort, the extension asks the
SDK to stop and waits briefly (up to two 2-second waits). If the work still hasn't
finished, the tool reports a failure but keeps the slot, run tracking and continuation
lock until the work actually ends. It can't kill an unresponsive provider, a shell
child process or a blocked event loop. Restart Pi, check for leftover processes and
look at the working tree before retrying. Use process or container isolation if you
need hard termination.

### Security and persistence

Read [SECURITY.md](SECURITY.md) before using agents on sensitive repositories.

- Subagents run with your OS permissions, environment, working tree and provider
  credentials.
- Subagents load **no extensions and no skills**. Permission hooks, sandbox hooks,
  custom tools and extension-only providers from the main session don't carry over.
  Project instructions and context are still loaded.
- Tool traces record lifecycle information, not arguments, results or reasoning.
  Assistant text and task previews can still contain secrets.
- Active runs are only tracked in memory and removed when they finish normally.
- Continuation transcripts are stored in
  `<agent-dir>/subagent-continuations/<parent-id-hash>/` (permissions `0700`) and can
  contain full tool payloads and model reasoning. They are never deleted automatically.

**Recovery:** check `/agents` and the working tree. A missing run record doesn't prove
every child process has stopped. Wait for running work to finish, or stop Pi on purpose
and look for leftover processes. Don't reload to get around running work. Only remove
continuation directories once nothing refers to them.

### Troubleshooting

| Symptom                                    | Check                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| No agents available / unknown agent        | Copy a definition into `<agent-dir>/agents/`, check its `name`, then run `/reload`.                              |
| Missing workflow agent                     | `/implement-review` needs both `implementor` and `code-reviewer`.                                                |
| Model unavailable / authentication failure | Use a model set up and authenticated in Pi settings or `models.json`; extension-only providers aren't passed on. |
| Custom tool unavailable                    | Subagents only get built-in tools; remove extension tools from the agent's `tools` list.                         |
| Project trust / cwd rejection              | Trust the project in Pi and use its directory or a subdirectory.                                                 |
| All slots blocked after a timeout          | Unfinished work still holds every slot. Check `/agents`; see cancellation above.                                 |
| Setup keeps failing                        | Setup failures are cached. Fix the configuration, then reload once old work has stopped.                         |

## Development

```sh
npm ci
npm run check          # strict types, formatting, offline tests
npm run test:package   # pack, unpack and load via the real Pi extension loader
npm run format
```

Requires Node.js 24+. The tests inject faults into fake sessions, check that tools
register and render correctly, run a real SDK continuation round trip against a fake
provider, and load the unpacked package. No API credentials are needed. CI runs Node 24
on Linux and macOS and Node 26 on Linux.

See [architecture](docs/architecture.md) for design trade-offs and
[benchmarks](docs/benchmarks.md) for optional live diagnostics. No performance gains are
claimed without reproducible measurements.

## License

[MIT](LICENSE) © 2026 Michael Brunner. Parts derived from Pi's subagent example keep
their original notice; see [NOTICE](NOTICE).
