import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig, ThinkingLevel } from "./agents.ts";
import type { ContinuationRecord } from "./continuation.ts";

export const DEFAULT_TIMEOUT_SECONDS = 1500;
export const MAX_TIMEOUT_SECONDS = 7200;
export const DEFAULT_STREAMING_UPDATE_DELAY_MS = 16;
export const DEFAULT_CLEANUP_GRACE_MS = 2_000;
export const RETAINED_MESSAGES_MAX_BYTES = 64 * 1024;
export const RETAINED_MESSAGES_MAX_COUNT = 32;
export const TRACE_ENTRY_MAX_BYTES = 8 * 1024;
export const TRACE_ENTRY_MAX_LINES = 80;
export const TRACE_TOTAL_MAX_BYTES = 32 * 1024;
export const TRACE_TOTAL_MAX_LINES = 400;
export const TRACE_MAX_ENTRIES = 128;

export interface TextBounds {
	maxBytes: number;
	maxLines: number;
}

export function isPathInside(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalDirectory(candidate: string, baseDir?: string): string {
	const resolved = path.resolve(baseDir ?? process.cwd(), candidate);
	let canonical: string;
	try {
		canonical = fs.realpathSync.native(resolved);
	} catch (error: unknown) {
		const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") throw new Error(`Child cwd does not exist: ${resolved}`);
		throw new Error(`Cannot resolve child cwd ${resolved}: ${errorText(error)}`);
	}
	try {
		if (!fs.statSync(canonical).isDirectory()) throw new Error(`Child cwd is not a directory: ${canonical}`);
	} catch (error: unknown) {
		if (error instanceof Error && error.message.startsWith("Child cwd is not a directory:")) throw error;
		throw new Error(`Cannot inspect child cwd ${canonical}: ${errorText(error)}`);
	}
	return canonical;
}

function hasProtectedPiResources(cwd: string, configDirName: string): boolean {
	const configDir = path.join(cwd, configDirName);
	return [
		path.join(configDir, "settings.json"),
		path.join(configDir, "extensions"),
		path.join(configDir, "skills"),
		path.join(configDir, "prompts"),
		path.join(configDir, "themes"),
		path.join(configDir, "SYSTEM.md"),
		path.join(configDir, "APPEND_SYSTEM.md"),
	].some((candidate) => fs.existsSync(candidate));
}

function projectSkillSearchBoundary(cwd: string): string {
	let current = cwd;
	while (true) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return current;
		current = parent;
	}
}

function hasProtectedProjectSkills(cwd: string): boolean {
	const boundary = projectSkillSearchBoundary(cwd);
	const globalSkills = path.resolve(os.homedir(), ".agents", "skills");
	let current = cwd;
	while (true) {
		const candidate = path.resolve(current, ".agents", "skills");
		if (candidate !== globalSkills && fs.existsSync(candidate)) return true;
		if (current === boundary) return false;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export function hasProtectedProjectResources(cwd: string, configDirName: string = ".pi"): boolean {
	return hasProtectedPiResources(cwd, configDirName) || hasProtectedProjectSkills(cwd);
}

export function validateChildCwd(options: {
	requestedCwd?: string;
	defaultCwd: string;
	projectTrusted: boolean;
	configDirName?: string;
}): string {
	const parentCwd = canonicalDirectory(options.defaultCwd);
	const childCwd = canonicalDirectory(options.requestedCwd ?? parentCwd, parentCwd);
	if (!hasProtectedProjectResources(childCwd, options.configDirName)) return childCwd;
	if (!options.projectTrusted) {
		throw new Error(
			`Child cwd contains protected project resources, but the current project is not trusted: ${childCwd}`,
		);
	}
	if (!isPathInside(childCwd, parentCwd)) {
		throw new Error(`Child cwd with protected project resources is outside the trusted cwd: ${childCwd}`);
	}
	return childCwd;
}

export function normalizeTimeoutSeconds(value: number | undefined): number {
	const timeout = value ?? DEFAULT_TIMEOUT_SECONDS;
	if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(
			`timeoutSeconds must be a finite non-negative number; supported maximum is ${MAX_TIMEOUT_SECONDS} seconds`,
		);
	}
	return timeout;
}

export function normalizeDispatchTimeoutSeconds(value: number | undefined): number {
	const timeout = normalizeTimeoutSeconds(value);
	if (timeout === 0)
		throw new Error("timeoutSeconds must be a finite positive number; zero disables the required deadline");
	return timeout;
}

export interface SkillResource {
	filePath: string;
}

export interface SkillResourceResult<TSkill extends SkillResource = SkillResource, TDiagnostic = unknown> {
	skills: TSkill[];
	diagnostics: TDiagnostic[];
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	contextTokens: number;
	turns: number;
}

export interface NestedModelUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export const FINAL_HANDOFF_MAX_BYTES = 24 * 1024;
export const FINAL_HANDOFF_MAX_LINES = 600;
export const COMBINED_HANDOFF_MAX_BYTES = 50 * 1024;
export const COMBINED_HANDOFF_MAX_LINES = 2000;
export const SUBAGENT_DISPATCH_GUIDANCE =
	"Use narrow, focused work packages with clear instructions. Avoid running expensive operations, such as builds, in parallel.";
export const CONCISE_HANDOFF_SYSTEM_PROMPT =
	"Return a concise final handoff. Lead with the outcome. Include only actionable findings or changes, exact evidence or paths needed, and validation status. Omit exploration narrative, repeated task context, and generic advice.";

export function createEmptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		contextTokens: 0,
		turns: 0,
	};
}

export function aggregateNestedUsage(usages: readonly UsageStats[]): NestedModelUsage {
	const total = createEmptyUsage();
	for (const usage of usages) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		total.costInput += usage.costInput;
		total.costOutput += usage.costOutput;
		total.costCacheRead += usage.costCacheRead;
		total.costCacheWrite += usage.costCacheWrite;
	}
	return {
		input: total.input,
		output: total.output,
		cacheRead: total.cacheRead,
		cacheWrite: total.cacheWrite,
		totalTokens: total.input + total.output + total.cacheRead + total.cacheWrite,
		cost: {
			input: total.costInput,
			output: total.costOutput,
			cacheRead: total.costCacheRead,
			cacheWrite: total.costCacheWrite,
			total: total.cost,
		},
	};
}

export function appendAgentSystemPrompt(base: readonly string[], agentSystemPrompt: string): string[] {
	return [...base, ...(agentSystemPrompt.trim() ? [agentSystemPrompt] : []), CONCISE_HANDOFF_SYSTEM_PROMPT];
}

export function boundFinalHandoff(output: string): string {
	return boundText(output, { maxBytes: FINAL_HANDOFF_MAX_BYTES, maxLines: FINAL_HANDOFF_MAX_LINES });
}

export function boundCombinedHandoffs(output: string): string {
	return boundText(output, { maxBytes: COMBINED_HANDOFF_MAX_BYTES, maxLines: COMBINED_HANDOFF_MAX_LINES });
}

/** Return the largest UTF-8 prefix that fits without splitting a code point. */
export function truncateUtf8AtByteLimit(value: string, maxBytes: number): { text: string; byteLength: number } {
	if (!Number.isInteger(maxBytes) || maxBytes < 0) {
		throw new Error("UTF-8 byte limit must be a non-negative integer");
	}

	let index = 0;
	let byteLength = 0;
	while (index < value.length) {
		const first = value.charCodeAt(index);
		let codeUnits = 1;
		let codePointBytes: number;
		if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
			const second = value.charCodeAt(index + 1);
			if (second >= 0xdc00 && second <= 0xdfff) {
				codeUnits = 2;
				codePointBytes = 4;
			} else {
				codePointBytes = 3;
			}
		} else if (first >= 0xd800 && first <= 0xdfff) {
			codePointBytes = 3;
		} else if (first <= 0x7f) {
			codePointBytes = 1;
		} else if (first <= 0x7ff) {
			codePointBytes = 2;
		} else {
			codePointBytes = 3;
		}

		if (byteLength + codePointBytes > maxBytes) break;
		byteLength += codePointBytes;
		index += codeUnits;
	}

	return { text: value.slice(0, index), byteLength };
}

export function boundText(value: string, bounds: TextBounds): string {
	if (!Number.isInteger(bounds.maxBytes) || bounds.maxBytes < 1) {
		throw new Error("Text maxBytes must be a positive integer");
	}
	if (!Number.isInteger(bounds.maxLines) || bounds.maxLines < 1) {
		throw new Error("Text maxLines must be a positive integer");
	}
	// Bound the prefix before splitting, so oversized inputs do not allocate an unbounded line array.
	const byteBounded = truncateUtf8AtByteLimit(value, bounds.maxBytes).text;
	const lines = byteBounded.split("\n");
	if (byteBounded.length === value.length && lines.length <= bounds.maxLines) return value;

	const marker = "[Output truncated.]";
	if (bounds.maxLines === 1 || bounds.maxBytes <= Buffer.byteLength(marker, "utf8")) {
		return truncateUtf8AtByteLimit(marker, bounds.maxBytes).text;
	}
	const separator = bounds.maxLines === 2 ? "\n" : "\n\n";
	const contentBudget = Math.max(
		0,
		bounds.maxBytes - Buffer.byteLength(separator, "utf8") - Buffer.byteLength(marker, "utf8"),
	);
	const lineBudget = Math.max(1, bounds.maxLines - separator.length);
	const lineBounded = lines.slice(0, lineBudget).join("\n");
	const prefix = truncateUtf8AtByteLimit(lineBounded, contentBudget).text;
	return prefix ? `${prefix}${separator}${marker}` : marker;
}

export function sanitizeAssistantMessage(message: AgentMessage): AgentMessage {
	const content: unknown[] = [];
	let textBlock: { type: "text"; text: string } | undefined;
	let textTruncated = false;
	let toolCount = 0;
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (!part || typeof part !== "object") continue;
			const record = part as Record<string, unknown>;
			if (record.type === "text" && typeof record.text === "string") {
				if (textTruncated) continue;
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					content.push(textBlock);
				}
				const combined = textBlock.text + record.text;
				textBlock.text = boundFinalHandoff(combined);
				textTruncated = textBlock.text !== combined;
			} else if (record.type === "toolCall" && typeof record.name === "string" && toolCount < 32) {
				toolCount++;
				content.push({ type: "toolCall", name: boundText(record.name, { maxBytes: 128, maxLines: 1 }), arguments: {} });
			}
		}
	}
	return { role: "assistant", content };
}

export interface AgentMessage {
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

export interface AgentSessionEvent {
	type: string;
	[key: string]: unknown;
}

export interface SessionLike {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void>;
	abort(): Promise<void>;
	dispose(): void | PromiseLike<void>;
}

export interface AgentSession extends SessionLike {}

export interface SdkTiming {
	setupMs: number;
	firstEventMs?: number;
	firstTextDeltaMs?: number;
	completionMs?: number;
	totalMs: number;
	timedOut: boolean;
}

export type SdkObservedPhase = "setup" | "provider" | "streaming" | "tool" | "cleanup";

export interface SdkTaskObserver {
	observeEvent(update: {
		phase: SdkObservedPhase;
		toolName?: string;
		clearTool?: boolean;
		thinkingLevel?: ThinkingLevel;
	}): void;
	appendOutput(delta: string): void;
	appendTrace?(entry: string): void;
}

export interface SdkContinuationCreateTarget {
	action: "create";
	thread: string;
	parentSessionId: string;
	parentScopedDirectory: string;
}

export interface SdkContinuationResumeTarget {
	action: "resume";
	parentScopedDirectory: string;
	record: ContinuationRecord;
}

export type SdkContinuationTarget = SdkContinuationCreateTarget | SdkContinuationResumeTarget;

export interface SdkTaskRequest {
	agent: AgentConfig;
	task: string;
	cwd: string;
	thinkingLevel?: ThinkingLevel;
	timeoutSeconds?: number;
	signal?: AbortSignal;
	observer?: SdkTaskObserver;
	/** Internal only: the parent has already selected and validated this target. */
	continuation?: SdkContinuationTarget;
}

export type SdkCancellationCause = "aborted" | "timedOut";

export interface SdkTimerApi {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface SdkTaskCancellation {
	readonly cause: SdkCancellationCause | undefined;
	readonly cancellation: Promise<SdkCancellationCause>;
	readonly cleanupErrors: readonly string[];
	request(cause: SdkCancellationCause): Promise<void>;
	attachSession(session: SessionLike): void;
	waitForAbort(): Promise<void>;
	disposeSession(session: SessionLike): Promise<void>;
	cleanup(): void;
}

const SYSTEM_TIMER_API: SdkTimerApi = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSdkTaskCancellation(
	request: Pick<SdkTaskRequest, "signal" | "timeoutSeconds">,
	timerApi: SdkTimerApi = SYSTEM_TIMER_API,
): SdkTaskCancellation {
	const timeoutSeconds = normalizeTimeoutSeconds(request.timeoutSeconds);
	let active = true;
	let cancellationCause: SdkCancellationCause | undefined;
	let attachedSession: SessionLike | undefined;
	let disposedSession: SessionLike | undefined;
	let abortPromise: Promise<void> | undefined;
	let timerHandle: unknown;
	let timerScheduled = false;
	let abortListener: (() => void) | undefined;
	const cleanupErrors: string[] = [];
	let resolveCancellation!: (cause: SdkCancellationCause) => void;
	const cancellation = new Promise<SdkCancellationCause>((resolve) => {
		resolveCancellation = resolve;
	});

	const recordCleanupError = (operation: string, error: unknown) => {
		cleanupErrors.push(`${operation}: ${errorText(error)}`);
	};

	const abortAttachedSession = (): Promise<void> => {
		if (!attachedSession || abortPromise) return abortPromise ?? Promise.resolve();
		abortPromise = Promise.resolve()
			.then(() => attachedSession?.abort())
			.catch((error: unknown) => {
				recordCleanupError("session.abort()", error);
			});
		return abortPromise;
	};

	const requestCancellation = (cause: SdkCancellationCause): Promise<void> => {
		if (cancellationCause) return abortPromise ?? Promise.resolve();
		if (!active) return Promise.resolve();
		cancellationCause = cause;
		resolveCancellation(cause);
		return abortAttachedSession();
	};

	abortListener = () => {
		void requestCancellation("aborted");
	};
	if (request.signal) {
		request.signal.addEventListener("abort", abortListener, { once: true });
		if (request.signal.aborted) void requestCancellation("aborted");
	}
	if (!cancellationCause && timeoutSeconds > 0) {
		try {
			const handle = timerApi.setTimeout(() => {
				void requestCancellation("timedOut");
			}, timeoutSeconds * 1000);
			timerHandle = handle;
			timerScheduled = true;
		} catch (error: unknown) {
			let listenerRollbackError: unknown;
			if (request.signal && abortListener) {
				const listener = abortListener;
				abortListener = undefined;
				try {
					request.signal.removeEventListener("abort", listener);
				} catch (rollbackError: unknown) {
					listenerRollbackError = rollbackError;
				}
			}
			if (listenerRollbackError !== undefined) {
				throw new Error(
					`${errorText(error)}; removeEventListener() rollback failed: ${errorText(listenerRollbackError)}`,
				);
			}
			throw error;
		}
	}

	const attachSession = (session: SessionLike): void => {
		if (attachedSession && attachedSession !== session) {
			throw new Error("A task cancellation state cannot manage multiple sessions");
		}
		attachedSession = session;
		if (cancellationCause) void abortAttachedSession();
	};

	const waitForAbort = (): Promise<void> => abortPromise ?? Promise.resolve();

	const cleanup = (): void => {
		if (!active) return;
		active = false;
		if (timerScheduled) {
			timerScheduled = false;
			const handle = timerHandle;
			timerHandle = undefined;
			try {
				timerApi.clearTimeout(handle);
			} catch (error: unknown) {
				recordCleanupError("clearTimeout()", error);
			}
		}
		if (request.signal && abortListener) {
			const listener = abortListener;
			abortListener = undefined;
			try {
				request.signal.removeEventListener("abort", listener);
			} catch (error: unknown) {
				recordCleanupError("removeEventListener()", error);
			}
		}
	};

	const disposeSession = async (session: SessionLike): Promise<void> => {
		attachSession(session);
		cleanup();
		try {
			await waitForAbort();
		} finally {
			if (disposedSession === session) return;
			disposedSession = session;
			try {
				await session.dispose();
			} catch (error: unknown) {
				recordCleanupError("session.dispose()", error);
			}
		}
	};

	return {
		get cause() {
			return cancellationCause;
		},
		cancellation,
		cleanupErrors,
		request: requestCancellation,
		attachSession,
		waitForAbort,
		disposeSession,
		cleanup,
	};
}

export interface SdkContinuationSnapshot {
	sessionId: string;
	sessionFile: string;
	leafId: string;
	cwd: string;
	/** Canonical agent-definition identity retained only for internal record construction. */
	agentFilePath?: string;
}

export interface SdkTaskResult {
	exitCode: number;
	/** Sanitized finalized assistant text and tool names; never raw tool results, arguments, or thinking. */
	messages: AgentMessage[];
	/** Bounded metadata-only observability trace; no tool arguments/results or reasoning text. */
	trace: string[];
	streamingText?: string;
	progress?: SdkProgress;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	cleanupError?: string;
	/** Internal only. Unsettled work retains its scheduler slot and registry. */
	settlement?: Promise<void>;
	/** Internal only: a durably committed continuation leaf. */
	continuation?: SdkContinuationSnapshot;
	timedOut: boolean;
	aborted: boolean;
	timing: SdkTiming;
}

export interface SdkProgress {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
	toolCallId?: string;
	toolName?: string;
	args?: string;
	partialResult?: string;
	result?: string;
	isError?: boolean;
}

export interface SdkTaskUpdate extends SdkTaskResult {
	text?: string;
	progress?: SdkProgress;
}

export type SdkTaskUpdateCallback = (update: SdkTaskUpdate) => void;

export interface SdkTaskCollectorOptions {
	startedAt?: number;
	setupMs?: number;
	cancellation?: SdkTaskCancellation;
	timerApi?: SdkTimerApi;
	now?: () => number;
	streamingUpdateDelayMs?: number;
	cleanupGraceMs?: number;
	onCleanupDiagnostic?: (message: string) => void;
}

export interface SdkRunnerServices<TModelRuntime = unknown> {
	modelRuntime: TModelRuntime;
}

function copyUsage(usage: UsageStats): UsageStats {
	return { ...usage };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageUsage(message: AgentMessage): Record<string, unknown> | undefined {
	return message.usage && typeof message.usage === "object" ? (message.usage as Record<string, unknown>) : undefined;
}

function createTaskResult(startedAt: number, setupMs: number, now: () => number): SdkTaskResult {
	return {
		exitCode: 0,
		messages: [],
		trace: [],
		usage: createEmptyUsage(),
		timedOut: false,
		aborted: false,
		timing: {
			setupMs,
			totalMs: Math.max(0, now() - startedAt),
			timedOut: false,
		},
	};
}

/** Wait only for a bounded grace period; retain the original promise for eventual cleanup. */
async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), milliseconds);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function collectSdkTask(
	request: SdkTaskRequest,
	session: SessionLike,
	onUpdate?: SdkTaskUpdateCallback,
	options: SdkTaskCollectorOptions = {},
): Promise<SdkTaskResult> {
	const now = options.now ?? (() => performance.now());
	const startedAt = options.startedAt ?? now();
	const setupMs = options.setupMs ?? 0;
	const result = createTaskResult(startedAt, setupMs, now);
	const timerApi = options.timerApi ?? SYSTEM_TIMER_API;
	const streamingUpdateDelayMs = options.streamingUpdateDelayMs ?? DEFAULT_STREAMING_UPDATE_DELAY_MS;
	let closed = false;
	let unsubscribe: (() => void) | undefined;
	let streamingText = "";
	let streamingTruncated = false;
	let observedOutputInMessage = false;
	let reasoningTraceActive = false;
	let lastEmittedStreamingText: string | undefined;
	let streamingUpdatePending = false;
	let streamingTimerScheduled = false;
	let streamingTimerHandle: unknown;
	let promptStartedAt: number | undefined;
	let primaryError: unknown;
	let observerError: unknown;
	const cleanupErrors: string[] = [];
	let cancellation: SdkTaskCancellation | undefined;
	let pendingPrompt: Promise<unknown> | undefined;
	const cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
	if (!Number.isFinite(cleanupGraceMs) || cleanupGraceMs < 0)
		throw new Error("cleanupGraceMs must be finite and non-negative");
	const diagnose = (message: string) => {
		try {
			(options.onCleanupDiagnostic ?? console.error)(`[subagent] ${message}`);
		} catch {
			/* isolated diagnostic sink */
		}
	};

	const observeEvent = (update: Parameters<NonNullable<SdkTaskRequest["observer"]>["observeEvent"]>[0]) => {
		try {
			request.observer?.observeEvent(update);
		} catch (error: unknown) {
			observerError ??= error;
		}
	};

	const appendObservedOutput = (delta: string) => {
		try {
			request.observer?.appendOutput(delta);
		} catch (error: unknown) {
			observerError ??= error;
		}
	};

	const appendTrace = (entry: string) => {
		const bounded = boundText(entry, { maxBytes: TRACE_ENTRY_MAX_BYTES, maxLines: TRACE_ENTRY_MAX_LINES });
		result.trace.push(bounded);
		while (
			result.trace.length > TRACE_MAX_ENTRIES ||
			Buffer.byteLength(result.trace.join("\n"), "utf8") > TRACE_TOTAL_MAX_BYTES ||
			result.trace.join("\n").split("\n").length > TRACE_TOTAL_MAX_LINES
		) {
			result.trace.shift();
		}
		try {
			request.observer?.appendTrace?.(bounded);
		} catch (error: unknown) {
			observerError ??= error;
		}
	};

	const refreshTiming = () => {
		result.timing.totalMs = Math.max(0, now() - startedAt);
		result.timing.timedOut = result.timedOut;
	};

	const snapshot = (text?: string, progress?: SdkProgress): SdkTaskUpdate => {
		refreshTiming();
		return {
			...result,
			messages: [...result.messages],
			trace: [...result.trace],
			usage: copyUsage(result.usage),
			timing: { ...result.timing },
			...(text === undefined ? {} : { text }),
			...(progress === undefined ? {} : { progress }),
		};
	};

	const emitUpdate = (text?: string, progress?: SdkProgress) => {
		if (!closed && !cancellation?.cause && onUpdate) onUpdate(snapshot(text, progress));
	};

	const clearStreamingTimer = () => {
		if (!streamingTimerScheduled) return;
		streamingTimerScheduled = false;
		const handle = streamingTimerHandle;
		streamingTimerHandle = undefined;
		try {
			timerApi.clearTimeout(handle);
		} catch (error: unknown) {
			cleanupErrors.push(`clearTimeout(): ${errorText(error)}`);
		}
	};

	const flushStreamingUpdate = () => {
		clearStreamingTimer();
		if (!streamingUpdatePending) return;
		streamingUpdatePending = false;
		if (closed || cancellation?.cause || !onUpdate || streamingText === lastEmittedStreamingText) return;
		lastEmittedStreamingText = streamingText;
		onUpdate(snapshot(streamingText));
	};

	const scheduleStreamingUpdate = () => {
		if (streamingTimerScheduled || !onUpdate || streamingUpdateDelayMs <= 0) return;
		streamingTimerScheduled = true;
		try {
			streamingTimerHandle = timerApi.setTimeout(() => {
				streamingTimerScheduled = false;
				streamingTimerHandle = undefined;
				if (!streamingUpdatePending || closed || cancellation?.cause || !onUpdate) return;
				streamingUpdatePending = false;
				if (streamingText === lastEmittedStreamingText) return;
				lastEmittedStreamingText = streamingText;
				onUpdate(snapshot(streamingText));
			}, streamingUpdateDelayMs);
		} catch (error: unknown) {
			streamingTimerScheduled = false;
			streamingTimerHandle = undefined;
			throw error;
		}
	};

	const emitStreamingText = () => {
		result.streamingText = streamingText;
		if (closed || cancellation?.cause || !onUpdate) return;
		if (lastEmittedStreamingText === undefined) {
			lastEmittedStreamingText = streamingText;
			onUpdate(snapshot(streamingText));
			return;
		}
		if (streamingText === lastEmittedStreamingText) return;
		streamingUpdatePending = true;
		if (streamingUpdateDelayMs <= 0) flushStreamingUpdate();
		else scheduleStreamingUpdate();
	};

	const recordFirstEvent = () => {
		if (result.timing.firstEventMs === undefined && promptStartedAt !== undefined) {
			result.timing.firstEventMs = Math.max(0, now() - promptStartedAt);
		}
	};

	const recordAssistantMessage = (message: AgentMessage) => {
		result.usage.turns++;
		const usage = messageUsage(message);
		if (usage) {
			result.usage.input += numberValue(usage.input);
			result.usage.output += numberValue(usage.output);
			result.usage.cacheRead += numberValue(usage.cacheRead);
			result.usage.cacheWrite += numberValue(usage.cacheWrite);
			const cost = usage.cost;
			if (typeof cost === "number") result.usage.cost += numberValue(cost);
			else if (cost && typeof cost === "object") {
				const values = cost as Record<string, unknown>;
				const inputCost = numberValue(values.input);
				const outputCost = numberValue(values.output);
				const cacheReadCost = numberValue(values.cacheRead);
				const cacheWriteCost = numberValue(values.cacheWrite);
				result.usage.costInput += inputCost;
				result.usage.costOutput += outputCost;
				result.usage.costCacheRead += cacheReadCost;
				result.usage.costCacheWrite += cacheWriteCost;
				result.usage.cost += numberValue(values.total) || inputCost + outputCost + cacheReadCost + cacheWriteCost;
			}
			result.usage.contextTokens = numberValue(usage.totalTokens);
		}
		if (typeof message.model === "string") result.model = message.model;
		if (typeof message.stopReason === "string") result.stopReason = message.stopReason;
		if (typeof message.errorMessage === "string") result.errorMessage = message.errorMessage;
		else result.errorMessage = undefined;
	};

	const handleEvent = (event: AgentSessionEvent) => {
		if (closed) return;
		recordFirstEvent();

		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			observeEvent({
				phase: "tool",
				...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
			});
		} else if (event.type === "tool_execution_end") {
			observeEvent({ phase: "provider", clearTool: true });
		} else if (event.type === "message_start" || event.type === "message_update") {
			observeEvent({ phase: "streaming" });
		} else if (event.type === "agent_end") {
			observeEvent({ phase: "cleanup", clearTool: true });
		} else {
			observeEvent({ phase: "provider" });
		}

		if (event.type === "message_start") {
			const message = event.message as AgentMessage | undefined;
			if (message?.role === "assistant") {
				flushStreamingUpdate();
				streamingText = "";
				streamingTruncated = false;
				observedOutputInMessage = false;
				reasoningTraceActive = false;
				lastEmittedStreamingText = undefined;
				result.streamingText = undefined;
			}
			return;
		}

		if (event.type === "message_update") {
			if (cancellation?.cause) return;
			const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
			if (assistantMessageEvent?.type === "thinking_delta") {
				if (!reasoningTraceActive) {
					reasoningTraceActive = true;
					appendTrace("reasoning active");
					emitUpdate();
				}
				return;
			}
			const delta =
				assistantMessageEvent?.type === "text_delta"
					? (assistantMessageEvent.delta ?? assistantMessageEvent.text_delta ?? assistantMessageEvent.text)
					: typeof event.text_delta === "string"
						? event.text_delta
						: typeof event.delta === "string"
							? event.delta
							: undefined;
			if (typeof delta === "string" && delta.length > 0) {
				appendObservedOutput(delta);
				observedOutputInMessage = true;
				if (result.timing.firstTextDeltaMs === undefined && promptStartedAt !== undefined) {
					result.timing.firstTextDeltaMs = Math.max(0, now() - promptStartedAt);
				}
				if (!streamingTruncated) {
					const combined = streamingText + delta;
					streamingText = boundFinalHandoff(combined);
					streamingTruncated = streamingText !== combined;
				}
				emitStreamingText();
			}
			return;
		}

		if (event.type === "message_end") {
			const message = event.message as AgentMessage | undefined;
			if (!message || typeof message.role !== "string") return;
			if (message.role === "assistant") {
				flushStreamingUpdate();
				if (!observedOutputInMessage && Array.isArray(message.content)) {
					const finalizedText = message.content
						.filter((part): part is { type: "text"; text: string } =>
							Boolean(
								part &&
									typeof part === "object" &&
									(part as Record<string, unknown>).type === "text" &&
									typeof (part as Record<string, unknown>).text === "string",
							),
						)
						.map((part) => part.text)
						.join("");
					if (finalizedText) appendObservedOutput(finalizedText);
				}
				recordAssistantMessage(message);
				result.messages.push(sanitizeAssistantMessage(message));
				while (
					result.messages.length > 1 &&
					(result.messages.length > RETAINED_MESSAGES_MAX_COUNT ||
						Buffer.byteLength(JSON.stringify(result.messages), "utf8") > RETAINED_MESSAGES_MAX_BYTES)
				)
					result.messages.shift();
				streamingText = "";
				streamingTruncated = false;
				lastEmittedStreamingText = undefined;
				result.streamingText = undefined;
				emitUpdate();
			}
			return;
		}

		if (event.type === "tool_result_end") return;

		if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end"
		) {
			const toolName = boundText(typeof event.toolName === "string" ? event.toolName : "unknown", {
				maxBytes: 128,
				maxLines: 1,
			});
			const action =
				event.type === "tool_execution_start"
					? "started"
					: event.type === "tool_execution_update"
						? "updated"
						: event.isError === true
							? "failed"
							: "completed";
			appendTrace(`tool ${action}: ${toolName}`);
			const progress: SdkProgress = {
				type: event.type,
				...(typeof event.toolCallId === "string" ? { toolCallId: event.toolCallId } : {}),
				...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),

				...(typeof event.isError === "boolean" ? { isError: event.isError } : {}),
			};
			result.progress = progress;
			if (!cancellation?.cause) emitUpdate(undefined, progress);
			return;
		}
	};

	try {
		cancellation = options.cancellation ?? createSdkTaskCancellation(request, options.timerApi);
		cancellation.attachSession(session);
		unsubscribe = session.subscribe(handleEvent);
		observeEvent({ phase: "provider" });
		if (cancellation.cause) {
			/* Do not start an already cancelled prompt. */
		} else {
			promptStartedAt = now();
			try {
				const prompt = Promise.resolve().then(() =>
					session.prompt(`Task: ${request.task}`, {
						preflightResult: (accepted) => {
							// SDK abort only affects existing work. Preparation (auth/compaction) can
							// finish later, even after we returned a failure with pending settlement.
							// Pi calls this synchronously before starting the accepted agent run.
							if (accepted && cancellation?.cause) throw new Error("Subagent cancelled during prompt preparation");
						},
					}),
				);
				const outcome = await Promise.race([
					prompt.then(() => "done" as const),
					cancellation.cancellation.then(() => "cancelled" as const),
				]);
				if (outcome === "cancelled" && !(await settlesWithin(prompt, cleanupGraceMs))) {
					pendingPrompt = prompt;
				} else await prompt;
			} finally {
				flushStreamingUpdate();
				result.timing.completionMs ??= Math.max(0, now() - promptStartedAt);
			}
		}
	} catch (error: unknown) {
		primaryError = error;
	} finally {
		observeEvent({ phase: "cleanup", clearTool: true });
		closed = true;
		streamingUpdatePending = false;
		clearStreamingTimer();
		if (cancellation) cancellation.cleanup();
		if (unsubscribe) {
			try {
				unsubscribe();
			} catch (error: unknown) {
				cleanupErrors.push(`unsubscribe(): ${errorText(error)}`);
			}
			unsubscribe = undefined;
		}
		const cleanup = async () => {
			// Never dispose a session while its prompt is still mutating state.
			if (pendingPrompt) await pendingPrompt.catch(() => undefined);
			if (cancellation) await cancellation.disposeSession(session);
			else await session.dispose();
		};
		const cleanupPromise = cleanup().catch((error: unknown) => {
			diagnose(`session cleanup: ${errorText(error)}`);
		});
		if (!pendingPrompt && (await settlesWithin(cleanupPromise, cleanupGraceMs))) {
			if (cancellation) cleanupErrors.push(...cancellation.cleanupErrors);
		} else {
			result.settlement = cleanupPromise.then(() => {
				for (const error of cancellation?.cleanupErrors ?? []) diagnose(error);
			});
			cleanupErrors.push(
				"Child cleanup is still pending; its concurrency slot remains reserved. Restart Pi if it never settles.",
			);
		}
	}

	if (primaryError === undefined && observerError !== undefined) primaryError = observerError;
	if (cancellation?.cause === "aborted") {
		result.aborted = true;
		result.timedOut = false;
	} else if (cancellation?.cause === "timedOut") {
		result.aborted = false;
		result.timedOut = true;
	}
	if (primaryError !== undefined) {
		if (!result.errorMessage) result.errorMessage = errorText(primaryError);
		if (!result.stopReason || result.stopReason === "stop") result.stopReason = "error";
	}
	if (result.aborted) result.stopReason = "aborted";
	else if (result.timedOut) result.stopReason = "timeout";
	if (cleanupErrors.length > 0) {
		result.cleanupError = cleanupErrors.join("; ");
		if (!result.errorMessage) result.errorMessage = result.cleanupError;
		if (!result.stopReason || result.stopReason === "stop") result.stopReason = "error";
	}
	if (
		result.stopReason === "error" ||
		result.stopReason === "length" ||
		result.stopReason === "aborted" ||
		result.stopReason === "timeout"
	) {
		result.exitCode = 1;
	}
	refreshTiming();
	return result;
}

export function disableSkills<TSkill extends SkillResource, TDiagnostic>(
	current: SkillResourceResult<TSkill, TDiagnostic>,
): SkillResourceResult<TSkill, TDiagnostic> {
	return {
		...current,
		skills: [],
	};
}
