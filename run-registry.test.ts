import assert from "node:assert/strict";
import test from "node:test";
import { ActiveRunRegistry, RUN_TAIL_MAX_BYTES, RUN_TAIL_MAX_LINES } from "./run-registry.ts";

function startInput() {
	return {
		agent: "scout",
		task: "Inspect the implementation",
		cwd: "/work/project",
		timeoutSeconds: 120,
		thinkingLevel: "high" as const,
	};
}

test("keeps active runs in the owning registry instance", () => {
	const owner = new ActiveRunRegistry({
		pid: 4242,
		now: () => 1_000,
	});
	const reader = new ActiveRunRegistry();
	const run = owner.start(startInput());

	const listed = owner.list();
	assert.equal(listed.length, 1);
	assert.equal(listed[0].runId, run.runId);
	assert.equal(listed[0].agent, "scout");
	assert.equal(listed[0].status, "active");
	assert.equal(listed[0].startedAt, 1_000);
	assert.equal(listed[0].lastOutputAt, undefined);
	assert.equal(listed[0].thinkingLevel, "high");
	assert.deepEqual(reader.list(), []);
	assert.throws(() => reader.get(run.runId), /not found/i);

	run.finish();
	assert.deepEqual(owner.list(), []);
	owner.shutdown();
	reader.shutdown();
});

test("publishes tool traces and distinguishes event from activity/output times", () => {
	let now = 10_000;
	const registry = new ActiveRunRegistry({ now: () => now });
	const run = registry.start(startInput());

	now = 10_100;
	run.observeEvent({ phase: "tool", toolName: "read", thinkingLevel: "xhigh" });
	let snapshot = registry.get(run.runId);
	assert.equal(snapshot.lastEventAt, 10_100);
	assert.equal(snapshot.lastOutputAt, undefined);
	assert.equal(snapshot.phase, "tool");
	assert.equal(snapshot.currentTool, "read");
	assert.equal(snapshot.thinkingLevel, "xhigh");

	now = 10_200;
	run.appendTrace('tool started: read {"path":"/work/project/file.ts"}');
	snapshot = registry.get(run.runId);
	assert.equal(snapshot.lastEventAt, 10_200);
	assert.equal(snapshot.lastOutputAt, 10_200);
	assert.match(snapshot.tail, /tool started: read.*file\.ts/);

	now = 10_250;
	run.appendOutput("partial answer");
	snapshot = registry.get(run.runId);
	assert.equal(snapshot.lastEventAt, 10_250);
	assert.equal(snapshot.lastOutputAt, 10_250);
	assert.match(snapshot.tail, /partial answer/);

	now = 10_300;
	run.observeEvent({ phase: "provider", clearTool: true });
	snapshot = registry.get(run.runId);
	assert.equal(snapshot.lastEventAt, 10_300);
	assert.equal(snapshot.lastOutputAt, 10_250);
	assert.equal(snapshot.currentTool, undefined);
	registry.shutdown();
});

test("retains bounded output directly in memory", () => {
	const registry = new ActiveRunRegistry();
	const run = registry.start(startInput());
	for (let index = 0; index < RUN_TAIL_MAX_LINES + 100; index++) {
		run.appendOutput(`${index}:${"x".repeat(300)}\n`);
	}
	const snapshot = registry.get(run.runId);
	assert.ok(Buffer.byteLength(snapshot.tail, "utf8") <= RUN_TAIL_MAX_BYTES);
	assert.ok(snapshot.tail.split("\n").length <= RUN_TAIL_MAX_LINES);
	assert.match(snapshot.tail, new RegExp(String(RUN_TAIL_MAX_LINES + 99)));
	assert.doesNotMatch(snapshot.tail, /^0:/);
	registry.shutdown();
});

test("live records remain active without a heartbeat or process check", () => {
	let now = 0;
	const registry = new ActiveRunRegistry({ now: () => now });
	const run = registry.start(startInput());
	now = 60_000;
	assert.equal(registry.get(run.runId).status, "active");
	run.finish();
	registry.shutdown();
});

test("preserving active runs retires starts but allows the owner to finish", () => {
	const registry = new ActiveRunRegistry();
	const run = registry.start(startInput());
	registry.shutdown({ preserveActive: true });

	assert.equal(registry.get(run.runId).status, "active");
	assert.throws(() => registry.start(startInput()), /registry is shut down/i);
	run.finish();
	assert.deepEqual(registry.list(), []);
	registry.shutdown();
});

test("shutdown removes all active runs by default", () => {
	const registry = new ActiveRunRegistry();
	const run = registry.start(startInput());
	registry.shutdown();
	assert.deepEqual(registry.list(), []);
	run.finish();
	assert.throws(() => registry.start(startInput()), /registry is shut down/i);
});

test("requires a unique run-id prefix for detail lookup", () => {
	const ids = ["abc111", "abc222"];
	const registry = new ActiveRunRegistry({ runId: () => ids.shift()! });
	registry.start(startInput());
	registry.start({ ...startInput(), agent: "reviewer" });
	assert.throws(() => registry.get("abc"), /ambiguous/i);
	assert.equal(registry.get("abc1").runId, "abc111");
	assert.throws(() => registry.get("missing"), /not found/i);
	registry.shutdown();
});
