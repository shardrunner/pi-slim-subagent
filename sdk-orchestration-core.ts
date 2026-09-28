import { sharedScheduler, type RunScheduler, type RunSlot } from "./scheduler.ts";
import {
	continuationFailure,
	parseContinuationRecord,
	validateContinuationAgentIdentity,
	type ContinuationRecord,
} from "./continuation.ts";
import type { AgentConfig } from "./agents.ts";
import {
	DEFAULT_TIMEOUT_SECONDS,
	normalizeDispatchTimeoutSeconds,
	createEmptyUsage,
	type AgentMessage,
	type SdkContinuationTarget,
	type SdkTaskObserver,
	type SdkTaskRequest,
	type SdkTaskResult,
	type SdkTaskUpdate,
	type SdkTaskUpdateCallback,
	type SdkTiming,
} from "./sdk-runner-core.ts";
import {
	preferCurrentStreamingText,
	runSdkTask,
	type SdkRunnerServices,
	type SdkRunnerServicesSource,
} from "./sdk-runner.ts";

export const MAX_CONCURRENCY = 4;
export type RunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface SingleResult {
	state: RunState;
	/** Internal only; never serialize into tool details. */
	settlement?: Promise<void>;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: AgentMessage[];
	trace?: string[];
	stderr: string;
	usage: SdkTaskResult["usage"];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	cleanupError?: string;
	timedOut: boolean;
	aborted: boolean;
	timeoutSeconds: number;
	timing: SdkTiming;
	streamingText?: string;
	progress?: SdkTaskResult["progress"];
	/** Internal only: a committed continuation pointer. */
	continuation?: ContinuationRecord;
}

export type SdkTaskRunner = (
	request: SdkTaskRequest,
	services: SdkRunnerServices,
	onUpdate?: SdkTaskUpdateCallback,
) => Promise<SdkTaskResult>;

export interface SingleAgentRunRequest {
	agentName: string;
	task: string;
	cwd?: string;
	thinkingLevel?: AgentConfig["thinkingLevel"];
	timeoutSeconds?: number;
	/** Internal only: an already selected persistent child target. */
	continuation?: SdkContinuationTarget;
}

export type SdkServicesSource = SdkRunnerServicesSource;

export interface SubagentRunRegistry {
	start(input: {
		agent: string;
		task: string;
		cwd: string;
		timeoutSeconds: number;
		thinkingLevel?: AgentConfig["thinkingLevel"];
	}): SdkTaskObserver & { readonly runId: string; finish(): void };
}

export interface OrchestrationContext {
	defaultCwd: string;
	agents: AgentConfig[];
	sdkServices: SdkServicesSource;
	signal?: AbortSignal;
	runTask?: SdkTaskRunner;
	runRegistry?: SubagentRunRegistry;
	scheduler?: RunScheduler;
}

export type SingleResultUpdateCallback = (result: SingleResult) => void;

export interface ParallelItemInput {
	agent: string;
	task: string;
	cwd?: string;
	thinkingLevel?: AgentConfig["thinkingLevel"];
	timeoutSeconds?: number;
}

export interface ParallelRunOptions extends OrchestrationContext {
	tasks: readonly ParallelItemInput[];
	topLevelThinkingLevel?: AgentConfig["thinkingLevel"];
	topLevelTimeoutSeconds?: number;
	onUpdate?: (results: SingleResult[]) => void;
}

function emptyTiming(): SdkTiming {
	return { setupMs: 0, totalMs: 0, timedOut: false };
}

function emptyUsage(): SdkTaskResult["usage"] {
	return createEmptyUsage();
}

export function selectThinkingLevel(
	itemThinkingLevel: AgentConfig["thinkingLevel"],
	topLevelThinkingLevel: AgentConfig["thinkingLevel"],
): AgentConfig["thinkingLevel"] {
	return itemThinkingLevel ?? topLevelThinkingLevel;
}

export function selectTimeoutSeconds(
	itemTimeoutSeconds: number | undefined,
	topLevelTimeoutSeconds: number | undefined,
): number {
	return normalizeDispatchTimeoutSeconds(
		itemTimeoutSeconds !== undefined ? itemTimeoutSeconds : topLevelTimeoutSeconds,
	);
}

export function getFinalOutput(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		const textParts = msg.content.filter(
			(part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string",
		);
		return textParts.map((part) => part.text).join("");
	}
	return "";
}

export function getCurrentOutput(result: Pick<SingleResult, "messages" | "streamingText">): string {
	return preferCurrentStreamingText(getFinalOutput(result.messages), result.streamingText);
}

export function isFailedResult(
	result: Pick<SingleResult, "exitCode" | "timedOut" | "aborted" | "stopReason">,
): boolean {
	return (
		result.exitCode !== 0 ||
		result.timedOut ||
		result.aborted ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.stopReason === "length" ||
		result.stopReason === "timeout"
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function failedSingleResult(result: SingleResult, error: unknown): SingleResult {
	return {
		...result,
		state: "failed",
		exitCode: 1,
		stderr: result.stderr || errorText(error),
		stopReason: "error",
		errorMessage: errorText(error),
		timedOut: false,
		aborted: false,
		timing: {
			...result.timing,
			totalMs: Math.max(result.timing.totalMs, 0),
		},
	};
}

function adaptSdkResult(
	agent: AgentConfig,
	agentName: string,
	task: string,
	timeoutSeconds: number,
	result: SdkTaskResult,
	continuationTarget?: SdkContinuationTarget,
): SingleResult {
	let continuation: ContinuationRecord | undefined;
	if (
		result.continuation !== undefined &&
		continuationTarget !== undefined &&
		result.exitCode === 0 &&
		result.cleanupError === undefined &&
		!result.aborted &&
		!result.timedOut &&
		(result.stopReason === undefined || result.stopReason === "stop" || result.stopReason === "end")
	) {
		try {
			const candidate =
				continuationTarget.action === "create"
					? {
							version: 1 as const,
							action: "create" as const,
							thread: continuationTarget.thread,
							parentSessionId: continuationTarget.parentSessionId,
							childSessionId: result.continuation.sessionId,
							childSessionFile: result.continuation.sessionFile,
							childLeafId: result.continuation.leafId,
							agent: {
								name: agent.name,
								source: agent.source,
								filePath: result.continuation.agentFilePath ?? agent.filePath,
							},
							cwd: result.continuation.cwd,
						}
					: {
							...continuationTarget.record,
							action: "resume" as const,
							childSessionId: result.continuation.sessionId,
							childSessionFile: result.continuation.sessionFile,
							childLeafId: result.continuation.leafId,
							agent: {
								name: agent.name,
								source: agent.source,
								filePath: result.continuation.agentFilePath ?? agent.filePath,
							},
							cwd: result.continuation.cwd,
						};
			continuation = parseContinuationRecord(candidate);
		} catch {
			throw continuationFailure("validation");
		}
	}
	return {
		state: result.aborted ? "cancelled" : isFailedResult(result) ? "failed" : "succeeded",
		settlement: result.settlement,
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: result.exitCode,
		messages: result.messages,
		trace: [...(result.trace ?? [])],
		stderr: result.errorMessage ?? "",
		usage: result.usage,
		model: result.model,
		stopReason: result.stopReason,
		errorMessage: result.errorMessage,
		cleanupError: result.cleanupError,
		timedOut: result.timedOut,
		aborted: result.aborted,
		timeoutSeconds,
		timing: result.timing,
		streamingText: result.streamingText,
		progress: result.progress,
		...(continuation === undefined ? {} : { continuation }),
	};
}

export async function runSingleAgent(
	context: OrchestrationContext,
	request: SingleAgentRunRequest,
	onUpdate?: SingleResultUpdateCallback,
): Promise<SingleResult> {
	if (typeof context.sdkServices !== "function") void Promise.resolve(context.sdkServices).catch(() => undefined);
	const timeoutSeconds = selectTimeoutSeconds(request.timeoutSeconds, undefined);
	const agent = context.agents.find((candidate) => candidate.name === request.agentName);

	if (!agent) {
		const available = context.agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
		return {
			state: "failed",
			agent: request.agentName,
			agentSource: "unknown",
			task: request.task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${request.agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			timedOut: false,
			aborted: false,
			timeoutSeconds,
			timing: emptyTiming(),
		};
	}

	let currentResult = adaptSdkResult(agent, request.agentName, request.task, timeoutSeconds, {
		exitCode: 0,
		messages: [],
		trace: [],
		usage: emptyUsage(),
		timedOut: false,
		aborted: false,
		timing: emptyTiming(),
	});

	if (request.continuation !== undefined) {
		try {
			validateContinuationAgentIdentity(agent);
			if (request.continuation.action === "resume") parseContinuationRecord(request.continuation.record);
		} catch {
			return failedSingleResult(currentResult, continuationFailure("validation"));
		}
	}

	let release: RunSlot | undefined;
	let settlement: Promise<void> | undefined;
	try {
		release = await (context.scheduler ?? sharedScheduler).acquire(context.signal);
		if (context.signal?.aborted) throw new Error("Subagent was aborted while queued");
		const cwd = request.cwd ?? context.defaultCwd;
		const thinkingLevel = request.thinkingLevel ?? agent.thinkingLevel;
		const activeRun = context.runRegistry?.start({
			agent: request.agentName,
			task: request.task,
			cwd,
			timeoutSeconds,
			thinkingLevel,
		});
		try {
			const taskRequest: SdkTaskRequest = {
				agent,
				task: request.task,
				cwd,
				thinkingLevel,
				timeoutSeconds,
				signal: context.signal,
				...(request.continuation === undefined ? {} : { continuation: request.continuation }),
				...(activeRun === undefined ? {} : { observer: activeRun }),
			};
			const onTaskUpdate = (update: SdkTaskUpdate) => {
				currentResult = adaptSdkResult(
					agent,
					request.agentName,
					request.task,
					timeoutSeconds,
					update,
					request.continuation,
				);
				currentResult.state = "running";
				if (update.streamingText === undefined && update.text !== undefined) currentResult.streamingText = update.text;
				onUpdate?.(currentResult);
			};
			const result = context.runTask
				? await context.runTask(
						taskRequest,
						await (typeof context.sdkServices === "function" ? context.sdkServices() : context.sdkServices),
						onTaskUpdate,
					)
				: await runSdkTask(taskRequest, context.sdkServices, onTaskUpdate);
			settlement = result.settlement;
			if (settlement) release.quarantine();
			return adaptSdkResult(agent, request.agentName, request.task, timeoutSeconds, result, request.continuation);
		} finally {
			if (settlement) {
				void settlement
					.then(() => activeRun?.finish())
					.catch((error) => console.error("[subagent] Late registry cleanup failed", error));
			} else activeRun?.finish();
		}
	} catch (error: unknown) {
		const failed = failedSingleResult(currentResult, error);
		if (context.signal?.aborted) {
			failed.state = "cancelled";
			failed.aborted = true;
			failed.stopReason = "aborted";
		}
		return failed;
	} finally {
		if (settlement)
			void settlement.then(
				() => release?.(),
				() => release?.(),
			);
		else release?.();
	}
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: readonly TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function placeholderResult(item: ParallelItemInput, timeoutSeconds: number): SingleResult {
	return {
		state: "queued",
		agent: item.agent,
		agentSource: "unknown",
		task: item.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		timedOut: false,
		aborted: false,
		timeoutSeconds,
		timing: emptyTiming(),
	};
}

export async function runParallel(options: ParallelRunOptions): Promise<SingleResult[]> {
	const topLevelThinkingLevel = options.topLevelThinkingLevel;
	const topLevelTimeoutSeconds = options.topLevelTimeoutSeconds;
	const allResults = options.tasks.map((item) =>
		placeholderResult(item, selectTimeoutSeconds(item.timeoutSeconds, topLevelTimeoutSeconds)),
	);
	const emit = () => options.onUpdate?.([...allResults]);

	return mapWithConcurrencyLimit(options.tasks, MAX_CONCURRENCY, async (item, index) => {
		const result = await runSingleAgent(
			options,
			{
				agentName: item.agent,
				task: item.task,
				cwd: item.cwd,
				thinkingLevel: selectThinkingLevel(item.thinkingLevel, topLevelThinkingLevel),
				timeoutSeconds: allResults[index].timeoutSeconds,
			},
			(current) => {
				allResults[index] = current;
				emit();
			},
		);
		allResults[index] = result;
		emit();
		return result;
	});
}

function formatSeconds(milliseconds: number): string {
	return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
}

function formatTimeoutSeconds(timeoutSeconds: number): string {
	return String(timeoutSeconds);
}

export function formatResultStatus(
	result: Pick<SingleResult, "timedOut" | "aborted" | "timeoutSeconds" | "stopReason" | "exitCode">,
): string | undefined {
	if (result.timedOut)
		return `timed out after ${formatTimeoutSeconds(result.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)}s`;
	if (result.aborted) return "aborted";
	if (result.stopReason && result.stopReason !== "stop" && result.stopReason !== "end") return result.stopReason;
	return result.exitCode !== 0 ? "failed" : undefined;
}

export function formatTimingFooter(timing: SdkTiming): string {
	const parts = [`total:${formatSeconds(timing.totalMs)}`];
	if (timing.firstTextDeltaMs !== undefined) parts.push(`ttft:${formatSeconds(timing.firstTextDeltaMs)}`);
	return parts.join(" ");
}
