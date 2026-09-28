import { randomUUID } from "node:crypto";

import { DEFAULT_TIMEOUT_SECONDS } from "./sdk-runner-core.ts";

export interface ImplementReviewThreadNames {
	implementor: string;
	reviewer: string;
}

function validateThreadName(value: string): string {
	if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)) {
		throw new Error("Implement-review continuation thread is invalid");
	}
	return value;
}

export function createImplementReviewThreadNames(
	now: number = Date.now(),
	nonce = randomUUID().slice(0, 8),
): ImplementReviewThreadNames {
	if (!Number.isSafeInteger(now) || now < 0)
		throw new Error("Implement-review timestamp must be a non-negative safe integer");
	if (!/^[a-f0-9]{8}$/.test(nonce)) throw new Error("Implement-review nonce must be eight hexadecimal characters");
	const prefix = `ir${now.toString(36)}-${nonce}`;
	return {
		implementor: validateThreadName(`${prefix}-implementor`),
		reviewer: validateThreadName(`${prefix}-reviewer`),
	};
}

export function buildImplementReviewWorkflowPrompt(task: string, threads: ImplementReviewThreadNames): string {
	const boundedTask = task.trim();
	if (!boundedTask) throw new Error("Usage: /implement-review <task>");
	const implementorThread = validateThreadName(threads.implementor);
	const reviewerThread = validateThreadName(threads.reviewer);
	if (implementorThread === reviewerThread) throw new Error("Implement-review continuation threads must be distinct");

	return `This /implement-review invocation explicitly authorizes the bounded advanced-subagent workflow below.

Task:
${boundedTask}

Execute this protocol exactly:

1. Load advanced subagents. Dispatch agent \`implementor\` with continuation \`create:${implementorThread}\` to implement only the task. Require red-green TDD when behavior is non-trivial and focused validation only, then commit the completed implementation according to repository instructions. Require it to report the resulting commit SHA and its base. Do not run broad repository gates yet.
2. After implementation completes, dispatch agent \`code-reviewer\` with continuation \`create:${reviewerThread}\`. Tell it to review the implementation commit or exact commit range reported by the implementor. Supply the exact diff and validation evidence so the reviewer does not need a shell. The reviewer is strictly read-only: inspect that change, the instructions, and existing validation evidence. Do not ask the reviewer to run builds or tests or to modify files. Require only concrete, actionable findings with exact paths and lines.
3. Resume \`${implementorThread}\` exactly once. Include the reviewer's exact actionable findings directly in the task. Fix only material findings, then perform final validation and commit material corrections separately from the implementation commit. Do not create an empty correction commit when no changes are needed.
4. Resume \`${reviewerThread}\` at most once, and only when step 2 reported material findings that step 3 changed code to address. Ask only for read-only verification of those corrections. Do not start another correction loop; report remaining findings to the user.

Limits:
- Use the default timeout: ${DEFAULT_TIMEOUT_SECONDS} seconds per dispatch for both agents; omit timeoutSeconds.
- Use only the two named continuation threads above and no other subagents.
- Stop on a timeout, failed dispatch, or material ambiguity and report it instead of broadening scope.
- Run focused checks during implementation and corrections; run full repository gates once, after convergence. Rerun a full gate only if a later change can invalidate it.
- The parent orchestrator coordinates the workflow but does not implement the delegated change itself.`;
}
