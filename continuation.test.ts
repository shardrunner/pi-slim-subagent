import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ADVANCED_SUBAGENT_TOOL_NAME } from "./tool-names.ts";
import {
	ContinuationLock,
	assertContinuationIdentity,
	canonicalizeContinuationAgentIdentity,
	continuationRootDirectory,
	deriveContinuationParentDirectory,
	ensureContinuationDirectories,
	findLatestContinuationRecord,
	parseContinuationRecord,
	validateContinuationAgentIdentity,
	validateContinuationChildPath,
	validateContinuationSession,
	validateContinuationThread,
	validateSessionAncestry,
	type ContinuationRecord,
	type ParentSessionEntry,
} from "./continuation.ts";

const agentFile = "/agents/reviewer.md";
const cwd = "/work/project";

function record(overrides: Partial<ContinuationRecord> = {}): ContinuationRecord {
	return {
		version: 1,
		action: "create",
		thread: "feature-a-review",
		parentSessionId: "parent-session",
		childSessionId: "child-session",
		childSessionFile: "/continuations/child.jsonl",
		childLeafId: "child-leaf-1",
		agent: { name: "reviewer", source: "user", filePath: agentFile },
		cwd,
		...overrides,
	};
}

function toolResultEntry(
	continuation: unknown,
	id = "tool-result-1",
	parentId: string | null = null,
	toolName = ADVANCED_SUBAGENT_TOOL_NAME,
): ParentSessionEntry {
	return {
		id,
		parentId,
		type: "message",
		message: {
			role: "toolResult",
			toolName,
			details: { continuation },
		},
	};
}

function withTempDirectory(fn: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "pi-continuation-test-"));
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("accepts only bounded ASCII continuation thread identifiers", () => {
	assert.equal(validateContinuationThread("feature-a_review"), "feature-a_review");
	assert.equal(validateContinuationThread("a"), "a");
	for (const invalid of ["", "-feature", "_feature", "feature/name", "feature name", "é", "a".repeat(65)]) {
		assert.throws(() => validateContinuationThread(invalid), /thread/i);
	}
});

test("validates oversized agent identity before canonicalization or child setup", () => {
	let canonicalizeCalls = 0;
	assert.throws(
		() =>
			canonicalizeContinuationAgentIdentity(
				{ name: "x".repeat(257), source: "user", filePath: "/agents/reviewer.md" },
				() => {
					canonicalizeCalls += 1;
					return "/agents/reviewer.md";
				},
			),
		/agent identity/i,
	);
	assert.equal(canonicalizeCalls, 0);
	assert.throws(
		() => validateContinuationAgentIdentity({ name: "reviewer", source: "user", filePath: "relative.md" }),
		/agent identity/i,
	);
});

test("persists canonical agent-definition paths and rejects symlink retargeting", () => {
	withTempDirectory((root) => {
		const targetA = join(root, "reviewer-a.md");
		const targetB = join(root, "reviewer-b.md");
		const link = join(root, "reviewer.md");
		writeFileSync(targetA, "agent-a");
		writeFileSync(targetB, "agent-b");
		symlinkSync(targetA, link);
		const canonical = canonicalizeContinuationAgentIdentity({ name: "reviewer", source: "user", filePath: link });
		assert.equal(canonical.filePath, targetA);
		const persisted = record({ agent: canonical, cwd: root });

		assert.doesNotThrow(() => assertContinuationIdentity(persisted, { agent: canonical, cwd: root }));
		unlinkSync(link);
		symlinkSync(targetB, link);
		assert.throws(
			() => assertContinuationIdentity(persisted, { agent: { ...canonical, filePath: link }, cwd: root }),
			/agent file identity/i,
		);
	});
});

test("derives parent storage from a SHA-256 digest without interpolating the raw ID", () => {
	const root = "/home/user/.pi/agent/subagent-continuations";
	const parentId = "../../parent/session with spaces";
	const digest = createHash("sha256").update(parentId, "utf8").digest("hex");

	assert.equal(continuationRootDirectory("/home/user/.pi/agent"), root);
	assert.equal(deriveContinuationParentDirectory(root, parentId), join(root, digest));
	assert.equal(deriveContinuationParentDirectory(root, parentId).includes(parentId), false);
});

test("creates and verifies private non-symlink continuation directories", () => {
	withTempDirectory((root) => {
		const continuationRoot = join(root, "continuations");
		const paths = ensureContinuationDirectories(continuationRoot, "parent-session");
		assert.equal(paths.rootDirectory, continuationRoot);
		assert.equal(lstatSync(paths.rootDirectory).isDirectory(), true);
		assert.equal(lstatSync(paths.parentDirectory).isDirectory(), true);
		assert.equal(lstatSync(paths.rootDirectory).mode & 0o777, 0o700);
		assert.equal(lstatSync(paths.parentDirectory).mode & 0o777, 0o700);

		chmodSync(paths.rootDirectory, 0o755);
		chmodSync(paths.parentDirectory, 0o755);
		ensureContinuationDirectories(continuationRoot, "parent-session");
		assert.equal(lstatSync(paths.rootDirectory).mode & 0o777, 0o700);
		assert.equal(lstatSync(paths.parentDirectory).mode & 0o777, 0o700);
	});

	withTempDirectory((root) => {
		const target = join(root, "target");
		mkdirSync(target);
		const continuationRoot = join(root, "continuations");
		symlinkSync(target, continuationRoot);
		assert.throws(() => ensureContinuationDirectories(continuationRoot, "parent-session"), /symlink/i);
	});

	withTempDirectory((root) => {
		const continuationRoot = join(root, "continuations");
		mkdirSync(continuationRoot);
		const parentDirectory = deriveContinuationParentDirectory(continuationRoot, "parent-session");
		const target = join(root, "target");
		mkdirSync(target);
		symlinkSync(target, parentDirectory);
		assert.throws(() => ensureContinuationDirectories(continuationRoot, "parent-session"), /symlink/i);
	});
});

test("requires continuation root and parent ownership to match the effective UID", () => {
	withTempDirectory((root) => {
		const continuationRoot = join(root, "continuations");
		const paths = ensureContinuationDirectories(continuationRoot, "parent-session");
		const ownerUid = lstatSync(paths.rootDirectory).uid;

		assert.throws(
			() => ensureContinuationDirectories(continuationRoot, "parent-session", () => ownerUid + 1),
			/root directory.*owner/i,
		);

		let checked = 0;
		assert.throws(
			() =>
				ensureContinuationDirectories(continuationRoot, "parent-session", () => {
					checked += 1;
					return checked === 1 ? ownerUid : ownerUid + 1;
				}),
			/parent directory.*owner/i,
		);
		assert.equal(checked, 2);
	});
});

test("accepts only a direct regular non-symlink JSONL child of the expected directory", () => {
	withTempDirectory((root) => {
		const parentDirectory = join(root, "parent");
		mkdirSync(parentDirectory, { mode: 0o700 });
		const child = join(parentDirectory, "child.jsonl");
		writeFileSync(child, "{}\n", { mode: 0o600 });
		assert.equal(validateContinuationChildPath(child, parentDirectory), child);

		writeFileSync(join(root, "outside.jsonl"), "{}\n");
		mkdirSync(join(parentDirectory, "nested"));
		mkdirSync(join(parentDirectory, "directory.jsonl"));
		writeFileSync(join(parentDirectory, "child.txt"), "{}\n");
		symlinkSync(child, join(parentDirectory, "link.jsonl"));

		assert.throws(() => validateContinuationChildPath(join(root, "outside.jsonl"), parentDirectory), /direct child/i);
		assert.throws(
			() => validateContinuationChildPath(join(parentDirectory, "nested", "x.jsonl"), parentDirectory),
			/direct child/i,
		);
		assert.throws(
			() => validateContinuationChildPath(join(parentDirectory, "directory.jsonl"), parentDirectory),
			/regular file/i,
		);
		assert.throws(() => validateContinuationChildPath(join(parentDirectory, "child.txt"), parentDirectory), /\.jsonl/i);
		assert.throws(
			() => validateContinuationChildPath(join(parentDirectory, "link.jsonl"), parentDirectory),
			/symlink/i,
		);
	});
});

test("strictly parses bounded continuation records", () => {
	const parsed = parseContinuationRecord(record());
	assert.deepEqual(parsed, record());
	assert.deepEqual(parseContinuationRecord(JSON.stringify(record({ action: "resume" }))), record({ action: "resume" }));

	const invalidRecords: unknown[] = [
		{ ...record(), version: 2 },
		{ ...record(), thread: "bad/thread" },
		{ ...record(), childSessionFile: "relative.jsonl" },
		{ ...record(), agent: { ...record().agent, source: "other" } },
		{ ...record(), extra: true },
		{ ...record(), agent: { ...record().agent, filePath: "x".repeat(4097) } },
		undefined,
		null,
		"not json",
	];
	for (const invalid of invalidRecords) assert.throws(() => parseContinuationRecord(invalid), /continuation record/i);

	assert.throws(
		() => parseContinuationRecord(JSON.stringify({ ...record(), task: "x".repeat(20_000) })),
		/continuation record/i,
	);
	assert.throws(() => parseContinuationRecord(`{"x":"${"x".repeat(20_000)}"}`), /continuation record/i);
});

test("looks up only the latest advanced-dispatch record with exact parent ownership", () => {
	const current = record();
	const foreign = record({ parentSessionId: "source-parent" });
	assert.deepEqual(findLatestContinuationRecord([], current.thread, current.parentSessionId), { kind: "none" });
	assert.deepEqual(findLatestContinuationRecord([toolResultEntry(current)], current.thread, current.parentSessionId), {
		kind: "current",
		record: current,
	});
	assert.deepEqual(findLatestContinuationRecord([toolResultEntry(foreign)], current.thread, current.parentSessionId), {
		kind: "foreign",
		record: foreign,
	});
	assert.deepEqual(
		findLatestContinuationRecord(
			[toolResultEntry(foreign, "first"), toolResultEntry(current, "second")],
			current.thread,
			current.parentSessionId,
		),
		{ kind: "current", record: current },
	);
	assert.deepEqual(
		findLatestContinuationRecord(
			[toolResultEntry(current, "first"), toolResultEntry(foreign, "second")],
			current.thread,
			current.parentSessionId,
		),
		{ kind: "foreign", record: foreign },
	);
	assert.deepEqual(
		findLatestContinuationRecord(
			[toolResultEntry(record({ thread: "other-thread" }))],
			current.thread,
			current.parentSessionId,
		),
		{ kind: "none" },
	);
	for (const ignoredToolName of ["subagent", "read"]) {
		assert.deepEqual(
			findLatestContinuationRecord(
				[toolResultEntry(current, "ignored-tool-result", null, ignoredToolName)],
				current.thread,
				current.parentSessionId,
			),
			{ kind: "none" },
		);
	}
	assert.throws(
		() =>
			findLatestContinuationRecord(
				[toolResultEntry({ ...current, thread: "bad/thread" })],
				current.thread,
				current.parentSessionId,
			),
		/continuation record/i,
	);
	assert.throws(
		() => findLatestContinuationRecord([toolResultEntry(undefined)], current.thread, current.parentSessionId),
		/continuation record/i,
	);
});

test("requires the same agent identity and canonical cwd", () => {
	withTempDirectory((root) => {
		const actualCwd = join(root, "project");
		const actualAgentFile = join(root, "reviewer.md");
		mkdirSync(actualCwd);
		writeFileSync(actualAgentFile, "agent");
		const expected = record({ cwd: actualCwd, agent: { name: "reviewer", source: "user", filePath: actualAgentFile } });
		const symlinkCwd = join(root, "cwd-link");
		const symlinkAgent = join(root, "agent-link.md");
		symlinkSync(actualCwd, symlinkCwd);
		symlinkSync(actualAgentFile, symlinkAgent);

		assert.doesNotThrow(() =>
			assertContinuationIdentity(expected, {
				agent: { name: "reviewer", source: "user", filePath: symlinkAgent },
				cwd: symlinkCwd,
			}),
		);
		for (const changed of [
			{ ...expected, agent: { ...expected.agent, name: "implementor" } },
			{ ...expected, agent: { ...expected.agent, source: "project" as const } },
			{ ...expected, cwd: join(root, "other") },
		]) {
			assert.throws(
				() => assertContinuationIdentity(changed, { agent: expected.agent, cwd: expected.cwd }),
				/identity|cwd|agent/i,
			);
		}
	});
});

test("validates complete, cycle-free ancestry and the recorded leaf", () => {
	const valid = [
		{ id: "root", parentId: null },
		{ id: "message", parentId: "root" },
		{ id: "leaf", parentId: "message" },
		{ id: "abandoned", parentId: "root" },
	];
	assert.doesNotThrow(() => validateSessionAncestry(valid, "leaf"));

	assert.throws(
		() =>
			validateSessionAncestry(
				[
					{ id: "root", parentId: null },
					{ id: "root", parentId: null },
				],
				"root",
			),
		/duplicate/i,
	);
	assert.throws(() => validateSessionAncestry([{ id: "leaf", parentId: "missing" }], "leaf"), /missing parent/i);
	assert.throws(
		() =>
			validateSessionAncestry(
				[
					{ id: "a", parentId: "b" },
					{ id: "b", parentId: "a" },
				],
				"a",
			),
		/cycle/i,
	);
	assert.throws(() => validateSessionAncestry([{ id: "root", parentId: null }], "missing-leaf"), /recorded leaf/i);
	assert.throws(
		() =>
			validateSessionAncestry(
				[
					{ id: "root", parentId: null },
					{ id: "orphan", parentId: "missing" },
				],
				"root",
			),
		/missing parent/i,
	);
});

test("validates the owned child session identity, cwd, ancestry, and recorded leaf together", () => {
	const continuation = record({ childSessionId: "child", childLeafId: "leaf", cwd });
	const session = {
		sessionId: "child",
		cwd,
		entries: [
			{ id: "root", parentId: null },
			{ id: "leaf", parentId: "root" },
		],
	};
	const lexicalCanonicalize = (candidate: string): string => candidate;
	assert.doesNotThrow(() => validateContinuationSession(session, continuation, lexicalCanonicalize));
	assert.throws(
		() => validateContinuationSession({ ...session, sessionId: "other" }, continuation, lexicalCanonicalize),
		/session ID/i,
	);
	assert.throws(
		() => validateContinuationSession({ ...session, cwd: "/other" }, continuation, lexicalCanonicalize),
		/cwd/i,
	);
});

test("retains a parent-thread lock through actual settlement", async () => {
	const lock = new ContinuationLock();
	let settle!: () => void;
	const settlement = new Promise<void>((resolve) => (settle = resolve));
	const first = lock.run(
		"parent",
		"feature-a-review",
		async () => "first",
		() => settlement,
	);
	assert.equal(await first, "first");
	await assert.rejects(
		lock.run("parent", "feature-a-review", async () => "second"),
		/already in use/i,
	);
	settle();
	await settlement;
	assert.equal(await lock.run("parent", "feature-a-review", async () => "retry"), "retry");
});

test("rejects contention immediately and releases parent-thread locks in every outcome", async () => {
	const lock = new ContinuationLock();
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const first = lock.run("parent", "feature-a-review", async () => {
		await held;
		return "first";
	});
	await assert.rejects(
		lock.run("parent", "feature-a-review", async () => "second"),
		/already in use/i,
	);
	const otherThread = lock.run("parent", "other-thread", async () => "other");
	release();
	assert.equal(await first, "first");
	assert.equal(await otherThread, "other");

	await assert.rejects(
		lock.run("parent", "feature-a-review", async () => {
			throw new Error("failed");
		}),
		/failed/,
	);
	assert.equal(await lock.run("parent", "feature-a-review", async () => "retry"), "retry");
	assert.equal(await lock.run("other-parent", "feature-a-review", async () => "independent"), "independent");
});
