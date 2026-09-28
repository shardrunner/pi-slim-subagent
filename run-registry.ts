import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "./agents.ts";

export const RUN_TAIL_MAX_BYTES = 32 * 1024;
export const RUN_TAIL_MAX_LINES = 200;
const TASK_PREVIEW_MAX_BYTES = 1024;

export type RunPhase = "setup" | "provider" | "streaming" | "tool" | "cleanup";
export type RunStatus = "active";

export interface StartRunInput {
	agent: string;
	task: string;
	cwd: string;
	timeoutSeconds: number;
	thinkingLevel?: ThinkingLevel;
}

export interface RunEventUpdate {
	phase: RunPhase;
	toolName?: string;
	thinkingLevel?: ThinkingLevel;
	clearTool?: boolean;
}

interface RunRecord {
	runId: string;
	instanceId: string;
	pid: number;
	agent: string;
	taskPreview: string;
	cwd: string;
	startedAt: number;
	lastEventAt: number;
	lastOutputAt?: number;
	phase: RunPhase;
	currentTool?: string;
	timeoutSeconds: number;
	thinkingLevel?: ThinkingLevel;
	deadlineAt?: number;
}

export interface RunSnapshot extends RunRecord {
	status: RunStatus;
	tail: string;
}

export interface ActiveRunHandle {
	readonly runId: string;
	observeEvent(update: RunEventUpdate): void;
	appendOutput(delta: string): void;
	appendTrace(entry: string): void;
	finish(): void;
}

export interface ActiveRunRegistryOptions {
	pid?: number;
	now?: () => number;
	runId?: () => string;
	instanceId?: string;
}

interface OwnedRun {
	snapshot: RunRecord;
	tail: string;
	finished: boolean;
}

function sanitizeVisibleText(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function utf8Head(value: string, maxBytes: number): string {
	value = sanitizeVisibleText(value);
	let result = "";
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		result += character;
		bytes += size;
	}
	return result;
}

function utf8Tail(value: string, maxBytes: number): string {
	const characters = Array.from(value);
	let bytes = 0;
	let start = characters.length;
	while (start > 0) {
		const size = Buffer.byteLength(characters[start - 1], "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		start--;
	}
	return characters.slice(start).join("");
}

function boundTail(value: string): string {
	value = sanitizeVisibleText(value);
	const lines = value.split("\n");
	const lineBounded = lines.length > RUN_TAIL_MAX_LINES ? lines.slice(-RUN_TAIL_MAX_LINES).join("\n") : value;
	return Buffer.byteLength(lineBounded, "utf8") > RUN_TAIL_MAX_BYTES
		? utf8Tail(lineBounded, RUN_TAIL_MAX_BYTES)
		: lineBounded;
}

export class ActiveRunRegistry {
	private readonly pid: number;
	private readonly now: () => number;
	private readonly createRunId: () => string;
	private readonly instanceId: string;
	private readonly owned = new Map<string, OwnedRun>();
	private closed = false;

	constructor(options: ActiveRunRegistryOptions = {}) {
		this.pid = options.pid ?? process.pid;
		this.now = options.now ?? Date.now;
		this.createRunId = options.runId ?? (() => randomUUID());
		this.instanceId = options.instanceId ?? randomUUID();
	}

	start(input: StartRunInput): ActiveRunHandle {
		if (this.closed) throw new Error("Subagent run registry is shut down");
		const runId = this.createRunId();
		if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Invalid subagent run ID: ${runId}`);
		if (this.owned.has(runId)) throw new Error(`Duplicate subagent run ID: ${runId}`);
		const startedAt = this.now();
		const owned: OwnedRun = {
			snapshot: {
				runId,
				instanceId: this.instanceId,
				pid: this.pid,
				agent: utf8Head(input.agent, 256),
				taskPreview: utf8Head(input.task, TASK_PREVIEW_MAX_BYTES),
				cwd: utf8Head(input.cwd, 4096),
				startedAt,
				lastEventAt: startedAt,
				phase: "setup",
				timeoutSeconds: input.timeoutSeconds,
				...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
				...(input.timeoutSeconds > 0 ? { deadlineAt: startedAt + input.timeoutSeconds * 1000 } : {}),
			},
			tail: "",
			finished: false,
		};
		this.owned.set(runId, owned);

		return {
			runId,
			observeEvent: (update) => {
				if (owned.finished) return;
				owned.snapshot.lastEventAt = this.now();
				owned.snapshot.phase = update.phase;
				if (update.toolName !== undefined) owned.snapshot.currentTool = utf8Head(update.toolName, 256);
				if (update.thinkingLevel !== undefined) owned.snapshot.thinkingLevel = update.thinkingLevel;
				if (update.clearTool) delete owned.snapshot.currentTool;
			},
			appendOutput: (delta) => {
				if (owned.finished || delta.length === 0) return;
				const sanitized = sanitizeVisibleText(delta);
				if (!sanitized) return;
				const timestamp = this.now();
				owned.snapshot.lastEventAt = timestamp;
				owned.snapshot.lastOutputAt = timestamp;
				owned.snapshot.phase = "streaming";
				owned.tail = boundTail(owned.tail + sanitized);
			},
			appendTrace: (entry) => {
				if (owned.finished || entry.length === 0) return;
				const sanitized = sanitizeVisibleText(entry);
				if (!sanitized) return;
				const timestamp = this.now();
				const separator = owned.tail && !owned.tail.endsWith("\n") ? "\n" : "";
				const trace = `${separator}${sanitized}\n`;
				owned.snapshot.lastEventAt = timestamp;
				owned.snapshot.lastOutputAt = timestamp;
				owned.tail = boundTail(owned.tail + trace);
			},
			finish: () => this.finishOwned(owned),
		};
	}

	list(): RunSnapshot[] {
		return Array.from(this.owned.values())
			.filter((owned) => !owned.finished)
			.map((owned) => this.toSnapshot(owned))
			.sort((left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId));
	}

	get(runIdPrefix: string): RunSnapshot {
		const prefix = runIdPrefix.trim();
		if (!prefix) throw new Error("A subagent run ID is required");
		const matches = this.list().filter((snapshot) => snapshot.runId.startsWith(prefix));
		if (matches.length === 0) throw new Error(`Subagent run not found: ${prefix}`);
		if (matches.length > 1) throw new Error(`Subagent run ID is ambiguous: ${prefix}`);
		return matches[0];
	}

	shutdown(options: { preserveActive?: boolean } = {}): void {
		this.closed = true;
		if (options.preserveActive) return;
		for (const owned of [...this.owned.values()]) this.finishOwned(owned);
	}

	private toSnapshot(owned: OwnedRun): RunSnapshot {
		return {
			...owned.snapshot,
			status: "active",
			tail: owned.tail,
		};
	}

	private finishOwned(owned: OwnedRun): void {
		if (owned.finished) return;
		owned.finished = true;
		this.owned.delete(owned.snapshot.runId);
	}
}
