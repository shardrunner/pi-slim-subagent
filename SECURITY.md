# Security model

This is a personal automation tool with full user-level system access, not a security sandbox.

## Trust boundaries

- A separate model context is not a separate OS identity or filesystem.
- Child sessions share the process, environment, provider credentials, and working tree. A shell-enabled agent can read or modify anything the Pi process can access and can start descendants.
- Child extension and skill discovery is disabled. **Parent permission gates, sandbox extensions, path protection, audit hooks, custom tools, and extension-defined providers are not inherited.** Do not delegate assuming those controls are active.
- Tool allowlists restrict available SDK tools, not the capabilities of a shell granted by that allowlist. The sample reviewer omits all shells and mutation tools; customized agents may not.
- Project-agent scope requires Pi project trust. Protected resources in an explicitly selected external cwd are rejected. Trust checks are not filesystem access controls: context files and tool reads can still contain hostile instructions.
- Agent definitions are trusted configuration. Project definitions override user names when scope is `both`.
- Handoff labels and escaping help distinguish reference data from instructions; they do not eliminate prompt injection. Advanced-mode opt-in and guided workflow limits are instructions to the parent model, not permissions enforced against it.

## Cancellation and concurrency

The execution deadline requests cooperative cancellation. A stalled event loop cannot run its timer. Providers and tools may ignore cancellation, and a shell may leave descendants behind. Bounded cleanup waiting does not terminate that work.

Unsettled work retains its slot, registry record, and instance-local continuation lock until actual settlement. These limits apply to one loaded module instance, not all Pi processes or later reloads. Do not use this extension as a spending limit or a hard resource governor.

Continuation exclusion covers only the owning extension instance, including unsettled work after a returned failure. Cross-Pi continuation and concurrent parent-session writers are unsupported. Do not simultaneously operate on the same parent session in multiple Pi instances or reload to bypass ongoing work.

## Data retained

| Location                                            | Contents                                                                                           | Retention                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Parent conversation                                 | Task/tool call, bounded final handoff, bounded metadata trace, usage, continuation locator details | Pi session lifetime                                                     |
| Owning extension's memory                           | Task preview, cwd, PID, timestamps, bounded assistant text and lifecycle trace                     | Removed on completion; not available after instance replacement/restart |
| `<agent-dir>/subagent-continuations/<parent-hash>/` | Full SDK child session JSONL                                                                       | Until explicitly removed                                                |

The collector excludes private thinking and tool payloads from its traces. This is **data minimization, not secret detection**. Assistant text can repeat secrets. Continuation transcripts are produced by the SDK and can retain full tool payloads and reasoning. Fresh sessions do not persist a child session JSONL, but their bounded handoffs still enter the parent session.

Directory and file permissions protect against other ordinary users on a typical Unix filesystem, not root or malicious code running as your user. Symlink/path/ownership checks reduce accidental or tampered continuation references; they are not designed to defeat an attacker concurrently modifying your files with the same UID.

## Reporting an issue

Use the hosting repository's private vulnerability reporting if available. Otherwise open a minimal public issue requesting a private contact channel, **without credentials, private code, session transcripts, or exploitable sensitive details**. Redact task previews, tool outputs, provider responses, and filesystem paths before sharing diagnostics. Do not include `auth.json` or environment dumps.
