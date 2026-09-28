import type {
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager as SettingsManagerType,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import {
	assertContinuationIdentity,
	canonicalizeContinuationAgentIdentity,
	ContinuationBoundaryError,
	ContinuationIdentityError,
	continuationFailure,
	parseContinuationRecord,
	validateContinuationAgentIdentity,
	validateContinuationChildPath,
	validateContinuationSession,
	validateSessionAncestry,
} from "./continuation.ts";
import {
	appendAgentSystemPrompt,
	collectSdkTask,
	createEmptyUsage,
	createSdkTaskCancellation,
	disableSkills,
	normalizeTimeoutSeconds,
} from "./sdk-runner-core.ts";
import type { ThinkingLevel } from "./agents.ts";
import type {
	AgentSession,
	SdkRunnerServices as CoreSdkRunnerServices,
	SdkTaskCancellation,
	SdkTaskRequest,
	SdkTaskResult,
	SdkTaskUpdateCallback,
	SdkTimerApi,
} from "./sdk-runner-core.ts";

export type SdkRunnerServices = CoreSdkRunnerServices<ModelRuntime>;
export type SdkRunnerServicesSource =
	| SdkRunnerServices
	| PromiseLike<SdkRunnerServices>
	| (() => SdkRunnerServices | PromiseLike<SdkRunnerServices>);

type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");
let piCodingAgentModule: Promise<PiCodingAgentModule> | undefined;

function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
	return (piCodingAgentModule ??= import("@earendil-works/pi-coding-agent"));
}

export async function createSdkRunnerServices(): Promise<SdkRunnerServices> {
	const { ModelRuntime } = await loadPiCodingAgent();
	return { modelRuntime: await ModelRuntime.create() };
}

/** Create a cached service getter without starting SDK initialization yet. */
export function createLazySdkRunnerServices(
	factory: () => SdkRunnerServices | PromiseLike<SdkRunnerServices> = createSdkRunnerServices,
): () => Promise<SdkRunnerServices> {
	let initialization: Promise<SdkRunnerServices> | undefined;
	return () => {
		if (initialization === undefined) {
			initialization = Promise.resolve().then(factory);
			// Preserve the rejection for the dispatch that awaits it, but mark this
			// shared promise handled even if a caller abandons that dispatch.
			void initialization.catch(() => undefined);
		}
		return initialization;
	};
}

export async function createChildResourceLoader(options: {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManagerType;
	agentSystemPrompt: string;
}): Promise<DefaultResourceLoader> {
	const { DefaultResourceLoader } = await loadPiCodingAgent();
	return new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
		// Child sessions are leaf agents: retain context discovery, but expose no skills.
		noExtensions: true,
		skillsOverride: (current) => disableSkills(current),
		appendSystemPromptOverride: (base) => appendAgentSystemPrompt(base, options.agentSystemPrompt),
	});
}

export type SdkSessionFactory = (request: SdkTaskRequest, services: SdkRunnerServices) => Promise<AgentSession>;

export interface SdkRunnerOptions {
	createSession?: SdkSessionFactory;
	/** Deterministic override for reopening a committed continuation child. */
	openContinuationSession?: (sessionFile: string) => unknown;
	timerApi?: SdkTimerApi;
	now?: () => number;
	streamingUpdateDelayMs?: number;
	cleanupGraceMs?: number;
	onCleanupDiagnostic?: (message: string) => void;
}

interface SdkSessionManager {
	getSessionId(): string;
	getCwd(): string;
	getEntries(): readonly unknown[];
	getLeafId(): string | null | undefined;
	getSessionFile(): string | undefined;
	isPersisted(): boolean;
	branch(entryId: string): void;
}

const sessionManagers = new WeakMap<object, SdkSessionManager>();
const continuationBaselines = new WeakMap<object, string | undefined>();

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sessionManagerFromSession(session: AgentSession): SdkSessionManager | undefined {
	const cached = sessionManagers.get(session as unknown as object);
	if (cached) return cached;
	const candidate = (session as unknown as { sessionManager?: unknown }).sessionManager;
	if (!candidate || typeof candidate !== "object") return undefined;
	const manager = candidate as Partial<SdkSessionManager>;
	if (
		typeof manager.getSessionId !== "function" ||
		typeof manager.getCwd !== "function" ||
		typeof manager.getEntries !== "function" ||
		typeof manager.getLeafId !== "function" ||
		typeof manager.getSessionFile !== "function" ||
		typeof manager.isPersisted !== "function" ||
		typeof manager.branch !== "function"
	) {
		return undefined;
	}
	return manager as SdkSessionManager;
}

function entryMessage(entry: unknown): Record<string, unknown> | undefined {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	const message = (entry as { message?: unknown }).message;
	return message && typeof message === "object" && !Array.isArray(message)
		? (message as Record<string, unknown>)
		: undefined;
}

function messageText(message: Record<string, unknown>): string | undefined {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content
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
	return text || undefined;
}

function sessionLineage(entries: readonly unknown[], leafId: string): readonly unknown[] {
	const byId = new Map<string, Record<string, unknown>>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const id = (entry as { id?: unknown }).id;
		if (typeof id === "string") byId.set(id, entry as Record<string, unknown>);
	}
	const lineage: unknown[] = [];
	const seen = new Set<string>();
	let current: string | null | undefined = leafId;
	while (current !== undefined && current !== null) {
		if (seen.has(current)) throw new Error(`Cycle in child session ancestry at entry: ${current}`);
		seen.add(current);
		const entry = byId.get(current);
		if (!entry) throw new Error(`Missing parent in child session ancestry: ${current}`);
		lineage.unshift(entry);
		const parentId = entry.parentId;
		if (parentId !== undefined && parentId !== null && typeof parentId !== "string") {
			throw new Error(`Invalid child session parent ID: ${current}`);
		}
		current = parentId as string | null | undefined;
	}
	return lineage;
}

function validateContinuationTurnSegment(
	entries: readonly unknown[],
	leafId: string,
	priorLeafId: string | undefined,
	task: string,
): void {
	validateSessionAncestry(entries, leafId);
	const lineage = sessionLineage(entries, leafId);
	const priorIndex =
		priorLeafId === undefined ? -1 : lineage.findIndex((entry) => (entry as { id?: unknown }).id === priorLeafId);
	if (priorLeafId !== undefined && priorIndex < 0) {
		throw new Error(`Persisted continuation leaf does not descend from the prior leaf: ${priorLeafId}`);
	}
	const segment = lineage.slice(priorIndex + 1);
	if (segment.length === 0) throw new Error("Persisted continuation leaf is unchanged");
	const acceptedTask = `Task: ${task}`;
	const userIndex = segment.findIndex((entry) => {
		const message = entryMessage(entry);
		return message?.role === "user" && (messageText(message) === task || messageText(message) === acceptedTask);
	});
	if (userIndex < 0) throw new Error("Persisted continuation segment is missing the accepted user task");
	const assistant = segment.slice(userIndex + 1).some((entry) => {
		const message = entryMessage(entry);
		return (
			message?.role === "assistant" &&
			(message.stopReason === "stop" || message.stopReason === "end") &&
			Object.hasOwn(message, "content")
		);
	});
	if (!assistant) throw new Error("Persisted continuation segment is missing a completed assistant message");
}

function observeServiceSource(source: SdkRunnerServicesSource): void {
	if (typeof source === "function") return;
	void Promise.resolve(source).catch(() => undefined);
}

function resolveServiceSource(source: SdkRunnerServicesSource): Promise<SdkRunnerServices> {
	return Promise.resolve().then(() => (typeof source === "function" ? source() : source));
}

export function preferCurrentStreamingText(finalizedText: string, streamingText?: string): string {
	if (streamingText && streamingText !== finalizedText) return streamingText;
	return finalizedText || streamingText || "";
}

export function selectSessionThinkingLevel(
	dispatchThinkingLevel: ThinkingLevel | undefined,
	configuredThinkingLevel: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
	return dispatchThinkingLevel ?? configuredThinkingLevel;
}

export interface SdkSessionConstructionOptions {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	model?: unknown;
	thinkingLevel?: unknown;
	tools?: string[];
	resourceLoader: unknown;
	sessionManager: unknown;
	settingsManager: unknown;
}

export interface SdkSessionConstructionInputs {
	request: SdkTaskRequest;
	services: SdkRunnerServices;
	agentDir: string;
	loader: unknown;
	settingsManager: unknown;
	model?: unknown;
	thinkingLevel?: unknown;
	sessionManager: unknown;
}

/** Keep production createAgentSession wiring inspectable without a provider call. */
export function buildCreateAgentSessionOptions(inputs: SdkSessionConstructionInputs): SdkSessionConstructionOptions {
	return {
		cwd: inputs.request.cwd,
		agentDir: inputs.agentDir,
		modelRuntime: inputs.services.modelRuntime,
		model: inputs.model,
		thinkingLevel: inputs.thinkingLevel,
		tools: inputs.request.agent.tools,
		resourceLoader: inputs.loader,
		sessionManager: inputs.sessionManager,
		settingsManager: inputs.settingsManager,
	};
}

function setupFailure(
	startedAt: number,
	setupMs: number,
	error: unknown,
	request: SdkTaskRequest,
	cancellation?: SdkTaskCancellation,
	now: () => number = () => performance.now(),
): SdkTaskResult {
	const cause = cancellation?.cause;
	const aborted = cause === "aborted" || (cause === undefined && (request.signal?.aborted ?? false));
	const timedOut = cause === "timedOut";
	return {
		exitCode: 1,
		messages: [],
		trace: [],
		usage: createEmptyUsage(),
		...(error === undefined ? {} : { errorMessage: errorText(error) }),
		stopReason: timedOut ? "timeout" : aborted ? "aborted" : "error",
		timedOut,
		aborted,
		timing: {
			setupMs,
			totalMs: Math.max(0, now() - startedAt),
			timedOut,
		},
	};
}

function appendCleanupErrors(result: SdkTaskResult, errors: readonly string[]): void {
	if (errors.length === 0) return;
	result.cleanupError = result.cleanupError ? `${result.cleanupError}; ${errors.join("; ")}` : errors.join("; ");
	if (!result.errorMessage) result.errorMessage = result.cleanupError;
	if (!result.stopReason || result.stopReason === "stop") result.stopReason = "error";
	result.exitCode = 1;
}

function freezeCancelledSetupResult(result: SdkTaskResult): SdkTaskResult {
	return Object.freeze({
		...result,
		messages: Object.freeze([...result.messages]),
		trace: Object.freeze([...result.trace]),
		usage: Object.freeze({ ...result.usage }),
		timing: Object.freeze({ ...result.timing }),
		...(result.progress === undefined ? {} : { progress: Object.freeze({ ...result.progress }) }),
	}) as unknown as SdkTaskResult;
}

const defaultCleanupDiagnostic = (message: string): void => {
	console.error(`[subagent] Late setup cleanup failure: ${message}`);
};

function safeDiagnosticErrorText(error: unknown): string {
	try {
		return errorText(error);
	} catch {
		return "[unprintable diagnostic error]";
	}
}

function reportLateCleanupDiagnostic(message: string, sink: (message: string) => void): void {
	try {
		sink(message);
		return;
	} catch (error: unknown) {
		const fallback = `cleanup diagnostic sink failed: ${safeDiagnosticErrorText(error)}; original cleanup error: ${message}`;
		try {
			defaultCleanupDiagnostic(fallback);
		} catch {
			// A replaced console may also throw. Keep the late continuation settled.
			try {
				process.stderr.write(`[subagent] Late setup cleanup failure: ${fallback}\n`);
			} catch {
				// There is no further reporting channel available.
			}
		}
	}
}

function observeLateSetup(
	setupPromise: Promise<AgentSession>,
	cancellation: SdkTaskCancellation,
	onCleanupDiagnostic: (message: string) => void,
): Promise<void> {
	let handled = false;
	const continuation = setupPromise.then(
		async (session) => {
			if (handled) return;
			handled = true;
			const cleanupErrorCount = cancellation.cleanupErrors.length;
			try {
				await cancellation.disposeSession(session);
			} finally {
				for (const error of cancellation.cleanupErrors.slice(cleanupErrorCount)) {
					reportLateCleanupDiagnostic(error, onCleanupDiagnostic);
				}
			}
		},
		() => {
			handled = true;
		},
	);
	return continuation.catch(() => undefined);
}

function throwIfSetupAborted(request: SdkTaskRequest): void {
	if (request.signal?.aborted) throw new Error("Subagent was aborted");
}

function acceptedContinuationTurn(result: SdkTaskResult): boolean {
	return (
		result.exitCode === 0 &&
		!result.cleanupError &&
		!result.aborted &&
		!result.timedOut &&
		(result.stopReason === undefined || result.stopReason === "stop" || result.stopReason === "end")
	);
}

function addContinuationLocator(locators: Set<string>, value: unknown): void {
	if (typeof value === "string" && value.length > 0) locators.add(value);
}

function continuationFailureLocators(request: SdkTaskRequest, session: AgentSession): readonly string[] {
	const target = request.continuation;
	if (target === undefined) return [];

	const locators = new Set<string>();
	addContinuationLocator(locators, target.parentScopedDirectory);
	if (target.action === "resume") {
		addContinuationLocator(locators, target.record.childSessionFile);
		addContinuationLocator(locators, target.record.childSessionId);
		addContinuationLocator(locators, target.record.childLeafId);
	}

	const manager = sessionManagerFromSession(session);
	if (manager) {
		for (const readLocator of [
			() => manager.getSessionFile(),
			() => manager.getSessionId(),
			() => manager.getLeafId(),
			() => continuationBaselines.get(manager as unknown as object),
		]) {
			try {
				addContinuationLocator(locators, readLocator());
			} catch {
				// Redaction must not change the established cleanup or failure path.
			}
		}
	}
	return [...locators];
}

function redactContinuationFailure(request: SdkTaskRequest, session: AgentSession, result: SdkTaskResult): void {
	if (request.continuation === undefined || acceptedContinuationTurn(result) || result.errorMessage === undefined)
		return;
	const modelVisibleError = result.errorMessage;
	if (continuationFailureLocators(request, session).some((locator) => modelVisibleError.includes(locator))) {
		result.errorMessage = continuationFailure("commitment").message;
	}
}

async function commitContinuation(
	request: SdkTaskRequest,
	session: AgentSession,
	result: SdkTaskResult,
	openContinuationSession?: (sessionFile: string) => unknown,
): Promise<void> {
	const target = request.continuation;
	if (target === undefined || !acceptedContinuationTurn(result)) return;

	try {
		const manager = sessionManagerFromSession(session);
		if (!manager) throw new Error("Continuation session manager is unavailable");
		if (!manager.isPersisted()) throw new Error("Continuation session manager is not persisted");

		const sessionFile = manager.getSessionFile();
		if (typeof sessionFile !== "string") throw new Error("Persisted continuation session has no session file");
		const childFile = validateContinuationChildPath(sessionFile, target.parentScopedDirectory);
		const parsedTarget = target.action === "resume" ? parseContinuationRecord(target.record) : undefined;
		if (parsedTarget !== undefined) {
			const recordedFile = path.resolve(parsedTarget.childSessionFile);
			if (childFile !== recordedFile) throw new Error("Continuation child session file changed during dispatch");
		}

		const reopened = openContinuationSession
			? (openContinuationSession(childFile) as SdkSessionManager)
			: ((await loadPiCodingAgent()).SessionManager.open(childFile) as SdkSessionManager);
		const leafId = reopened.getLeafId();
		if (typeof leafId !== "string" || leafId.length === 0) {
			throw new Error("Persisted continuation session has no leaf after dispatch");
		}
		const sessionId = reopened.getSessionId();
		const cwd = reopened.getCwd();
		const entries = reopened.getEntries();
		const priorLeafId =
			target.action === "resume" ? parsedTarget?.childLeafId : continuationBaselines.get(manager as unknown as object);
		if (priorLeafId !== undefined && leafId === priorLeafId) {
			throw new Error("Persisted continuation leaf is unchanged");
		}
		const agent = canonicalizeContinuationAgentIdentity(request.agent);
		const targetRecord =
			target.action === "create"
				? parseContinuationRecord({
						version: 1,
						action: "create",
						thread: target.thread,
						parentSessionId: target.parentSessionId,
						childSessionId: sessionId,
						childSessionFile: childFile,
						childLeafId: leafId,
						agent,
						cwd: request.cwd,
					})
				: parseContinuationRecord({
						...parsedTarget,
						action: "resume",
						childSessionId: sessionId,
						childSessionFile: childFile,
						childLeafId: leafId,
						agent,
						cwd: request.cwd,
					});
		validateContinuationSession({ sessionId, cwd, entries }, targetRecord);
		validateContinuationTurnSegment(entries, leafId, priorLeafId, request.task);
		result.continuation = {
			sessionId,
			sessionFile: childFile,
			leafId,
			cwd,
			agentFilePath: targetRecord.agent.filePath,
		};
	} catch (error: unknown) {
		if (error instanceof ContinuationBoundaryError) throw error;
		throw continuationFailure("commitment");
	}
}

async function createSdkSession(request: SdkTaskRequest, services: SdkRunnerServices): Promise<AgentSession> {
	const { createAgentSession, getAgentDir, resolveCliModel, SessionManager, SettingsManager } =
		await loadPiCodingAgent();
	const agentDir = getAgentDir();
	let sessionManager: SdkSessionManager;
	if (request.continuation === undefined) {
		// Fresh requests must stay ephemeral and must not acquire a session path.
		sessionManager = SessionManager.inMemory(request.cwd) as SdkSessionManager;
	} else {
		let canonicalAgent;
		try {
			canonicalAgent = canonicalizeContinuationAgentIdentity(request.agent);
		} catch {
			throw continuationFailure("preparation");
		}
		// Keep the orchestration result and the SDK request aligned with the persisted identity.
		request.agent.filePath = canonicalAgent.filePath;

		if (request.continuation.action === "create") {
			try {
				sessionManager = SessionManager.create(
					request.cwd,
					request.continuation.parentScopedDirectory,
				) as SdkSessionManager;
			} catch {
				throw continuationFailure("preparation");
			}
		} else {
			let record;
			try {
				record = parseContinuationRecord(request.continuation.record);
			} catch {
				throw continuationFailure("validation");
			}
			try {
				assertContinuationIdentity(record, { agent: canonicalAgent, cwd: request.cwd });
			} catch (error: unknown) {
				if (error instanceof ContinuationIdentityError) throw error;
				throw continuationFailure("validation");
			}
			try {
				const childFile = validateContinuationChildPath(
					record.childSessionFile,
					request.continuation.parentScopedDirectory,
				);
				const opened = SessionManager.open(childFile) as SdkSessionManager;
				validateContinuationSession(
					{
						sessionId: opened.getSessionId(),
						cwd: opened.getCwd(),
						entries: opened.getEntries(),
					},
					record,
				);
				opened.branch(record.childLeafId);
				sessionManager = opened;
			} catch {
				throw continuationFailure("validation");
			}
		}
	}
	if (request.continuation !== undefined) {
		continuationBaselines.set(
			sessionManager as unknown as object,
			request.continuation.action === "resume"
				? request.continuation.record.childLeafId
				: (sessionManager.getLeafId() ?? undefined),
		);
	}
	const settingsManager = SettingsManager.create(request.cwd, agentDir);
	const loader = await createChildResourceLoader({
		cwd: request.cwd,
		agentDir,
		settingsManager,
		agentSystemPrompt: request.agent.systemPrompt,
	});
	throwIfSetupAborted(request);
	await loader.reload();
	throwIfSetupAborted(request);

	const resolved = request.agent.model
		? resolveCliModel({ cliModel: request.agent.model, modelRuntime: services.modelRuntime })
		: undefined;
	if (resolved?.error) throw new Error(resolved.error);
	throwIfSetupAborted(request);

	const sessionOptions = buildCreateAgentSessionOptions({
		request,
		services,
		agentDir,
		loader,
		settingsManager,
		model: resolved?.model,
		thinkingLevel: selectSessionThinkingLevel(request.thinkingLevel, resolved?.thinkingLevel),
		sessionManager,
	});
	const { session } = await createAgentSession(
		sessionOptions as Parameters<PiCodingAgentModule["createAgentSession"]>[0],
	);
	const createdSession = session as AgentSession;
	if (createdSession && typeof createdSession === "object")
		sessionManagers.set(createdSession as unknown as object, sessionManager);
	const thinkingLevel = (session as unknown as { thinkingLevel?: unknown }).thinkingLevel;
	if (isThinkingLevel(thinkingLevel)) {
		request.observer?.observeEvent({ phase: "setup", thinkingLevel });
	}
	return session as AgentSession;
}

async function runSdkTaskImpl(
	request: SdkTaskRequest,
	services: SdkRunnerServicesSource,
	onUpdate?: SdkTaskUpdateCallback,
	options: SdkRunnerOptions = {},
): Promise<SdkTaskResult> {
	const now = options.now ?? (() => performance.now());
	const startedAt = now();
	if (request.continuation !== undefined) {
		try {
			validateContinuationAgentIdentity(request.agent);
			if (request.continuation.action === "resume") parseContinuationRecord(request.continuation.record);
		} catch {
			return setupFailure(startedAt, 0, continuationFailure("validation"), request, undefined, now);
		}
		try {
			request.agent.filePath = canonicalizeContinuationAgentIdentity(request.agent).filePath;
		} catch {
			return setupFailure(startedAt, 0, continuationFailure("preparation"), request, undefined, now);
		}
	}
	observeServiceSource(services);
	try {
		normalizeTimeoutSeconds(request.timeoutSeconds);
	} catch (error: unknown) {
		return setupFailure(startedAt, 0, error, request, undefined, now);
	}

	if (request.signal?.aborted) {
		return {
			...setupFailure(startedAt, 0, new Error("Subagent was aborted"), request, undefined, now),
			errorMessage: undefined,
			stopReason: "aborted",
		};
	}

	let cancellation: SdkTaskCancellation;
	try {
		cancellation = createSdkTaskCancellation(request, options.timerApi);
	} catch (error: unknown) {
		return setupFailure(startedAt, 0, error, request, undefined, now);
	}

	const sessionSetupStartedAt = now();
	const setupPromise = Promise.resolve().then(async () => {
		const resolvedServices = await resolveServiceSource(services);
		return (options.createSession ?? createSdkSession)(request, resolvedServices);
	});
	const setupOutcome = await Promise.race([
		setupPromise.then(
			(session) => ({ kind: "session" as const, session }),
			(error: unknown) => ({ kind: "error" as const, error }),
		),
		cancellation.cancellation.then((cause) => ({ kind: "cancelled" as const, cause })),
	]);

	if (setupOutcome.kind === "cancelled") {
		cancellation.cleanup();
		const settlement = observeLateSetup(
			setupPromise,
			cancellation,
			options.onCleanupDiagnostic ?? defaultCleanupDiagnostic,
		);
		const result = setupFailure(
			startedAt,
			Math.max(0, now() - sessionSetupStartedAt),
			undefined,
			request,
			cancellation,
			now,
		);
		result.settlement = settlement;
		appendCleanupErrors(result, [...cancellation.cleanupErrors]);
		return freezeCancelledSetupResult(result);
	}

	if (setupOutcome.kind === "error") {
		cancellation.cleanup();
		const result = setupFailure(
			startedAt,
			Math.max(0, now() - sessionSetupStartedAt),
			setupOutcome.error,
			request,
			cancellation,
			now,
		);
		appendCleanupErrors(result, cancellation.cleanupErrors);
		return result;
	}

	const session = setupOutcome.session;
	try {
		cancellation.attachSession(session);
	} catch (error: unknown) {
		cancellation.cleanup();
		let disposeError: unknown;
		try {
			await session.dispose();
		} catch (errorDuringDispose: unknown) {
			disposeError = errorDuringDispose;
		}
		const result = setupFailure(
			startedAt,
			Math.max(0, now() - sessionSetupStartedAt),
			error,
			request,
			cancellation,
			now,
		);
		appendCleanupErrors(result, cancellation.cleanupErrors);
		if (disposeError !== undefined) appendCleanupErrors(result, [`session.dispose(): ${errorText(disposeError)}`]);
		return result;
	}

	const result = await collectSdkTask(request, session, onUpdate, {
		startedAt,
		setupMs: Math.max(0, now() - sessionSetupStartedAt),
		cancellation,
		timerApi: options.timerApi,
		now,
		streamingUpdateDelayMs: options.streamingUpdateDelayMs,
		cleanupGraceMs: options.cleanupGraceMs,
		onCleanupDiagnostic: options.onCleanupDiagnostic,
	});
	redactContinuationFailure(request, session, result);
	if (
		request.continuation !== undefined &&
		result.cleanupError !== undefined &&
		result.errorMessage === result.cleanupError
	) {
		result.errorMessage = continuationFailure("commitment").message;
	}
	try {
		await commitContinuation(request, session, result, options.openContinuationSession);
	} catch (error: unknown) {
		const failure = error instanceof ContinuationBoundaryError ? error : continuationFailure("commitment");
		result.exitCode = 1;
		result.stopReason = "error";
		result.errorMessage = failure.message;
		result.continuation = undefined;
	}
	return result;
}

export async function runSdkTask(
	request: SdkTaskRequest,
	services: SdkRunnerServicesSource,
	onUpdate?: SdkTaskUpdateCallback,
	options: SdkRunnerOptions = {},
): Promise<SdkTaskResult> {
	const startedAt = performance.now();
	observeServiceSource(services);
	try {
		return await runSdkTaskImpl(request, services, onUpdate, options);
	} catch (error) {
		return setupFailure(startedAt, 0, error, request);
	}
}
