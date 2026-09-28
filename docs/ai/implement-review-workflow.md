---
summary: Bounded opt-in persistent implementor and code-reviewer workflow provided by the subagent extension.
read_when:
  - Changing the /implement-review slash command.
  - Changing continuation, timeout, or reviewer behavior in the subagent extension.
---

# Implement-review workflow

`/implement-review <task>` explicitly authorizes a bounded advanced-subagent workflow. Normal sessions retain the global opt-in policy and do not delegate unless instructed.

The command sends the parent agent a generated orchestration prompt with unique continuation threads and this fixed sequence:

1. Create one persistent `implementor` for the requested implementation, focused validation, and an implementation commit.
2. Create one persistent, strictly read-only `code-reviewer` for that commit or exact commit range.
3. Resume the implementor exactly once with the review findings, perform final validation, and commit material corrections separately.
4. Resume the reviewer at most once when material findings required code corrections.

The workflow stops instead of starting another correction loop. Reviewer prompts prohibit builds, tests, edits, and other mutating commands. Findings passed between separate continuations must be included explicitly; `{previous}` is accepted only in chain mode and is rejected for single or parallel dispatches.

All public subagent dispatches require a finite positive timeout. The default is 1740 seconds (29 minutes), the maximum is 7200 seconds, and the workflow uses 2400 seconds for implementors and 1200 seconds for reviewers. Internal cancellation tests may still use zero to exercise no-timer behavior; zero is not accepted at a dispatch boundary.

Run focused checks during implementation and corrections. Run full repository gates once after convergence, rerunning them only when a later change can invalidate the result.
