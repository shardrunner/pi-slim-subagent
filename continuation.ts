import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { ADVANCED_SUBAGENT_TOOL_NAME } from "./tool-names.ts";

export const CONTINUATION_ROOT_NAME = "subagent-continuations";
export const MAX_CONTINUATION_THREAD_BYTES = 64;
export const MAX_CONTINUATION_RECORD_BYTES = 16 * 1024;

const MAX_IDENTIFIER_BYTES = 256;
const MAX_PATH_BYTES = 4096;
const PRIVATE_DIRECTORY_MODE = 0o700;

export type EffectiveUidProvider = () => number | undefined;

function currentEffectiveUid(): number | undefined {
	const getEffectiveUid = (process as unknown as { geteuid?: () => number }).geteuid;
	return typeof getEffectiveUid === "function" ? getEffectiveUid() : undefined;
}

export type ContinuationAction = "create" | "resume";
export type AgentSource = "user" | "project";

export interface ContinuationAgentIdentity {
	name: string;
	source: AgentSource;
	filePath: string;
}

export interface ContinuationRecord {
	version: 1;
	action: ContinuationAction;
	thread: string;
	parentSessionId: string;
	childSessionId: string;
	childSessionFile: string;
	childLeafId: string;
	agent: ContinuationAgentIdentity;
	cwd: string;
}

export interface ContinuationDirectories {
	rootDirectory: string;
	parentDirectory: string;
}

export interface ParentSessionEntry {
	id: string;
	parentId?: string | null;
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
}

export type ContinuationLookup =
	| { kind: "none" }
	| { kind: "current"; record: ContinuationRecord }
	| { kind: "foreign"; record: ContinuationRecord };

export interface ContinuationSession {
	sessionId: string;
	cwd: string;
	entries: readonly unknown[];
}

export type ContinuationFailurePhase = "preparation" | "validation" | "commitment";

const CONTINUATION_FAILURE_MESSAGES: Record<ContinuationFailurePhase, string> = {
	preparation: "Continuation preparation failed",
	validation: "Continuation state validation failed",
	commitment: "Continuation commitment failed",
};

export class ContinuationBoundaryError extends Error {
	readonly phase: ContinuationFailurePhase;

	constructor(phase: ContinuationFailurePhase) {
		super(CONTINUATION_FAILURE_MESSAGES[phase]);
		this.name = "ContinuationBoundaryError";
		this.phase = phase;
	}
}

export class ContinuationIdentityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContinuationIdentityError";
	}
}

export function continuationFailure(phase: ContinuationFailurePhase): ContinuationBoundaryError {
	return new ContinuationBoundaryError(phase);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function invalidRecord(reason: string): never {
	throw new Error(`Invalid continuation record: ${reason}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0) invalidRecord(`${label} must be a non-empty string`);
	if (Buffer.byteLength(value, "utf8") > maxBytes) invalidRecord(`${label} exceeds its size limit`);
	if (/[\u0000-\u001f\x7f]/u.test(value)) invalidRecord(`${label} contains control characters`);
	return value;
}

function boundedIdentifier(value: unknown, label: string): string {
	return boundedString(value, label, MAX_IDENTIFIER_BYTES);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const required = [...expected].sort();
	if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
		invalidRecord(`${label} has unexpected or missing fields`);
	}
}

function absolutePath(value: unknown, label: string): string {
	const filePath = boundedString(value, label, MAX_PATH_BYTES);
	if (!path.isAbsolute(filePath)) invalidRecord(`${label} must be absolute`);
	return filePath;
}

export function validateContinuationAgentIdentity(value: unknown): ContinuationAgentIdentity {
	if (!isObject(value)) throw new Error("Invalid continuation agent identity");
	let name: string;
	let filePath: string;
	try {
		name = boundedString(value.name, "agent.name", MAX_IDENTIFIER_BYTES);
		filePath = absolutePath(value.filePath, "agent.filePath");
	} catch {
		throw new Error("Invalid continuation agent identity");
	}
	if (value.source !== "user" && value.source !== "project") {
		throw new Error("Invalid continuation agent identity");
	}
	return { name, source: value.source, filePath };
}

export function canonicalizeContinuationAgentIdentity(
	value: unknown,
	canonicalize: (candidate: string) => string = (candidate) => realpathSync.native(candidate),
): ContinuationAgentIdentity {
	const identity = validateContinuationAgentIdentity(value);
	let filePath: string;
	try {
		filePath = canonicalize(identity.filePath);
	} catch {
		throw new Error("Continuation agent file identity cannot be canonicalized");
	}
	try {
		return validateContinuationAgentIdentity({ ...identity, filePath });
	} catch {
		throw new Error("Continuation agent file identity is invalid");
	}
}

function assertParentSessionId(parentSessionId: string): void {
	if (typeof parentSessionId !== "string" || parentSessionId.length === 0) {
		throw new Error("Parent session ID must be a non-empty string");
	}
	if (Buffer.byteLength(parentSessionId, "utf8") > MAX_IDENTIFIER_BYTES) {
		throw new Error("Parent session ID exceeds its size limit");
	}
	if (/[\u0000-\u001f\x7f]/u.test(parentSessionId)) {
		throw new Error("Parent session ID contains control characters");
	}
}

export function validateContinuationThread(thread: unknown): string {
	if (
		typeof thread !== "string" ||
		Buffer.byteLength(thread, "utf8") > MAX_CONTINUATION_THREAD_BYTES ||
		!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(thread)
	) {
		throw new Error(
			`Invalid continuation thread: expected an ASCII identifier of at most ${MAX_CONTINUATION_THREAD_BYTES} bytes`,
		);
	}
	return thread;
}

export function continuationRootDirectory(agentDirectory: string): string {
	if (typeof agentDirectory !== "string" || !path.isAbsolute(agentDirectory)) {
		throw new Error("Pi agent directory must be an absolute path");
	}
	return path.join(agentDirectory, CONTINUATION_ROOT_NAME);
}

export function deriveContinuationParentDirectory(rootDirectory: string, parentSessionId: string): string {
	if (typeof rootDirectory !== "string" || !path.isAbsolute(rootDirectory)) {
		throw new Error("Continuation root directory must be an absolute path");
	}
	assertParentSessionId(parentSessionId);
	const digest = createHash("sha256").update(parentSessionId, "utf8").digest("hex");
	return path.join(rootDirectory, digest);
}

function verifyPrivateDirectory(
	directory: string,
	label: string,
	create: boolean,
	getEffectiveUid: EffectiveUidProvider,
): void {
	let stats;
	try {
		stats = lstatSync(directory);
	} catch (error: unknown) {
		const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
		if (code !== "ENOENT" || !create) {
			throw new Error(`Cannot inspect continuation ${label} ${directory}: ${errorText(error)}`);
		}
		try {
			mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		} catch (mkdirError: unknown) {
			const mkdirCode =
				mkdirError && typeof mkdirError === "object" ? (mkdirError as { code?: unknown }).code : undefined;
			if (mkdirCode !== "EEXIST") throw new Error(`Cannot create continuation ${label}: ${errorText(mkdirError)}`);
		}
		try {
			stats = lstatSync(directory);
		} catch (inspectError: unknown) {
			throw new Error(`Cannot inspect continuation ${label} ${directory}: ${errorText(inspectError)}`);
		}
	}
	if (stats.isSymbolicLink()) throw new Error(`Continuation ${label} must not be a symlink: ${directory}`);
	if (!stats.isDirectory()) throw new Error(`Continuation ${label} is not a directory: ${directory}`);
	const effectiveUid = getEffectiveUid();
	if (effectiveUid !== undefined && typeof stats.uid === "number" && stats.uid !== effectiveUid) {
		throw new Error(
			`Continuation ${label} is not owned by effective UID ${effectiveUid}: ${directory} (owner UID ${stats.uid})`,
		);
	}
	try {
		chmodSync(directory, PRIVATE_DIRECTORY_MODE);
		stats = lstatSync(directory);
	} catch (error: unknown) {
		throw new Error(`Cannot secure continuation ${label} ${directory}: ${errorText(error)}`);
	}
	if (stats.isSymbolicLink()) throw new Error(`Continuation ${label} must not be a symlink: ${directory}`);
	if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
		throw new Error(`Continuation ${label} is not mode 0700: ${directory}`);
	}
}

export function ensureContinuationDirectories(
	rootDirectory: string,
	parentSessionId: string,
	getEffectiveUid: EffectiveUidProvider = currentEffectiveUid,
): ContinuationDirectories {
	if (typeof rootDirectory !== "string" || !path.isAbsolute(rootDirectory)) {
		throw new Error("Continuation root directory must be an absolute path");
	}
	const parentDirectory = deriveContinuationParentDirectory(rootDirectory, parentSessionId);
	verifyPrivateDirectory(rootDirectory, "root directory", true, getEffectiveUid);
	verifyPrivateDirectory(parentDirectory, "parent directory", true, getEffectiveUid);
	return { rootDirectory, parentDirectory };
}

export function validateContinuationChildPath(recordedChildFile: string, expectedParentDirectory: string): string {
	if (
		typeof recordedChildFile !== "string" ||
		Buffer.byteLength(recordedChildFile, "utf8") > MAX_PATH_BYTES ||
		/[\u0000-\u001f\x7f]/u.test(recordedChildFile) ||
		!path.isAbsolute(recordedChildFile)
	) {
		throw new Error("Continuation child path must be a bounded absolute path");
	}
	if (typeof expectedParentDirectory !== "string" || !path.isAbsolute(expectedParentDirectory)) {
		throw new Error("Expected continuation parent directory must be an absolute path");
	}

	let parentStats;
	try {
		parentStats = lstatSync(expectedParentDirectory);
	} catch (error: unknown) {
		throw new Error(`Cannot inspect expected continuation parent directory: ${errorText(error)}`);
	}
	if (parentStats.isSymbolicLink()) throw new Error("Expected continuation parent directory must not be a symlink");
	if (!parentStats.isDirectory()) throw new Error("Expected continuation parent path is not a directory");

	const candidate = path.resolve(recordedChildFile);
	const expected = path.resolve(expectedParentDirectory);
	if (path.dirname(candidate) !== expected) {
		throw new Error("Recorded continuation child must be a direct child of the expected directory");
	}
	if (!candidate.endsWith(".jsonl")) throw new Error("Recorded continuation child must have a .jsonl extension");

	let stats;
	try {
		stats = lstatSync(candidate);
	} catch (error: unknown) {
		throw new Error(`Cannot inspect recorded continuation child: ${errorText(error)}`);
	}
	if (stats.isSymbolicLink()) throw new Error("Recorded continuation child must not be a symlink");
	if (!stats.isFile()) throw new Error("Recorded continuation child must be a regular file");
	return candidate;
}

export function parseContinuationRecord(input: unknown): ContinuationRecord {
	let value: unknown = input;
	if (typeof input === "string") {
		if (Buffer.byteLength(input, "utf8") > MAX_CONTINUATION_RECORD_BYTES) {
			invalidRecord("exceeds the record size limit");
		}
		try {
			value = JSON.parse(input);
		} catch (error: unknown) {
			invalidRecord(`invalid JSON: ${errorText(error)}`);
		}
	}
	if (!isObject(value)) invalidRecord("expected an object");

	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch (error: unknown) {
		invalidRecord(`cannot serialize value: ${errorText(error)}`);
	}
	if (typeof serialized !== "string") invalidRecord("cannot serialize value");
	if (Buffer.byteLength(serialized, "utf8") > MAX_CONTINUATION_RECORD_BYTES) {
		invalidRecord("exceeds the record size limit");
	}

	exactKeys(
		value,
		[
			"version",
			"action",
			"thread",
			"parentSessionId",
			"childSessionId",
			"childSessionFile",
			"childLeafId",
			"agent",
			"cwd",
		],
		"record",
	);
	if (value.version !== 1) invalidRecord("version must be 1");
	if (value.action !== "create" && value.action !== "resume") invalidRecord("action is invalid");
	let thread: string;
	try {
		thread = validateContinuationThread(value.thread);
	} catch (error: unknown) {
		invalidRecord(errorText(error));
	}
	const parentSessionId = boundedIdentifier(value.parentSessionId, "parentSessionId");
	const childSessionId = boundedIdentifier(value.childSessionId, "childSessionId");
	const childLeafId = boundedIdentifier(value.childLeafId, "childLeafId");
	const childSessionFile = absolutePath(value.childSessionFile, "childSessionFile");
	if (!childSessionFile.endsWith(".jsonl")) invalidRecord("childSessionFile must have a .jsonl extension");
	const cwd = absolutePath(value.cwd, "cwd");
	if (!isObject(value.agent)) invalidRecord("agent must be an object");
	exactKeys(value.agent, ["name", "source", "filePath"], "agent");
	const name = boundedString(value.agent.name, "agent.name", MAX_IDENTIFIER_BYTES);
	if (value.agent.source !== "user" && value.agent.source !== "project") invalidRecord("agent.source is invalid");
	const filePath = absolutePath(value.agent.filePath, "agent.filePath");

	return {
		version: 1,
		action: value.action,
		thread,
		parentSessionId,
		childSessionId,
		childSessionFile,
		childLeafId,
		agent: { name, source: value.agent.source, filePath },
		cwd,
	};
}

function continuationFromEntry(entry: unknown): { value: unknown } | undefined {
	if (!isObject(entry)) return undefined;
	const message = entry.message;
	if (!isObject(message) || message.role !== "toolResult" || message.toolName !== ADVANCED_SUBAGENT_TOOL_NAME)
		return undefined;
	const details = message.details;
	if (!isObject(details) || !Object.hasOwn(details, "continuation")) return undefined;
	return { value: details.continuation };
}

export function findLatestContinuationRecord(
	branch: readonly unknown[],
	thread: string,
	parentSessionId: string,
): ContinuationLookup {
	validateContinuationThread(thread);
	assertParentSessionId(parentSessionId);
	let latest: ContinuationRecord | undefined;
	for (const entry of branch) {
		const candidate = continuationFromEntry(entry);
		if (candidate === undefined) continue;
		const parsed = parseContinuationRecord(candidate.value);
		if (parsed.thread === thread) latest = parsed;
	}
	if (!latest) return { kind: "none" };
	return latest.parentSessionId === parentSessionId
		? { kind: "current", record: latest }
		: { kind: "foreign", record: latest };
}

function canonicalPath(label: string, value: string, canonicalize: (candidate: string) => string): string {
	try {
		return canonicalize(value);
	} catch {
		throw new Error(`Continuation ${label} cannot be canonicalized`);
	}
}

export function assertContinuationIdentity(
	record: ContinuationRecord,
	expected: { agent: ContinuationAgentIdentity; cwd: string },
	canonicalize: (candidate: string) => string = (candidate) => realpathSync.native(candidate),
): void {
	let expectedAgent: ContinuationAgentIdentity;
	try {
		expectedAgent = validateContinuationAgentIdentity(expected.agent);
	} catch {
		throw new ContinuationIdentityError("Invalid continuation agent identity");
	}
	const recordAgent = validateContinuationAgentIdentity(record.agent);
	if (recordAgent.name !== expectedAgent.name) {
		throw new ContinuationIdentityError("Continuation agent identity does not match");
	}
	if (recordAgent.source !== expectedAgent.source) {
		throw new ContinuationIdentityError("Continuation agent source does not match");
	}
	if (
		canonicalPath("agent file", recordAgent.filePath, canonicalize) !==
		canonicalPath("agent file", expectedAgent.filePath, canonicalize)
	) {
		throw new ContinuationIdentityError("Continuation agent file identity does not match");
	}
	if (canonicalPath("cwd", record.cwd, canonicalize) !== canonicalPath("cwd", expected.cwd, canonicalize)) {
		throw new ContinuationIdentityError("Continuation cwd does not match");
	}
}

function sessionEntry(value: unknown): { id: string; parentId?: string | null } {
	if (!isObject(value)) throw new Error("Invalid child session entry: expected an object");
	if (typeof value.id !== "string" || value.id.length === 0) throw new Error("Invalid child session entry ID");
	if (Buffer.byteLength(value.id, "utf8") > MAX_IDENTIFIER_BYTES || /[\u0000-\u001f\x7f]/u.test(value.id)) {
		throw new Error("Invalid child session entry ID");
	}
	if (value.parentId !== undefined && value.parentId !== null) {
		if (
			typeof value.parentId !== "string" ||
			value.parentId.length === 0 ||
			Buffer.byteLength(value.parentId, "utf8") > MAX_IDENTIFIER_BYTES ||
			/[\u0000-\u001f\x7f]/u.test(value.parentId)
		) {
			throw new Error("Invalid child session parent ID");
		}
	}
	return { id: value.id, parentId: value.parentId as string | null | undefined };
}

export function validateSessionAncestry(entries: readonly unknown[], recordedLeafId: string): void {
	if (!Array.isArray(entries) || entries.length === 0) throw new Error("Child session has no entries");
	const normalized = entries.map(sessionEntry);
	const byId = new Map<string, { id: string; parentId?: string | null }>();
	for (const entry of normalized) {
		if (byId.has(entry.id)) throw new Error(`Duplicate child session entry ID: ${entry.id}`);
		byId.set(entry.id, entry);
	}
	if (!byId.has(recordedLeafId)) throw new Error(`Recorded leaf is absent from child session: ${recordedLeafId}`);

	const states = new Map<string, "visiting" | "visited">();
	const visit = (id: string): void => {
		const state = states.get(id);
		if (state === "visiting") throw new Error(`Cycle in child session ancestry at entry: ${id}`);
		if (state === "visited") return;
		const entry = byId.get(id);
		if (!entry) throw new Error(`Missing parent in child session ancestry: ${id}`);
		states.set(id, "visiting");
		if (entry.parentId !== undefined && entry.parentId !== null) {
			if (!byId.has(entry.parentId)) throw new Error(`Missing parent in child session ancestry: ${entry.parentId}`);
			visit(entry.parentId);
		}
		states.set(id, "visited");
	};
	for (const entry of normalized) visit(entry.id);
}

export function validateContinuationSession(
	session: ContinuationSession,
	record: ContinuationRecord,
	canonicalize: (candidate: string) => string = (candidate) => realpathSync.native(candidate),
): void {
	if (session.sessionId !== record.childSessionId) throw new Error("Continuation child session ID does not match");
	if (canonicalPath("cwd", session.cwd, canonicalize) !== canonicalPath("cwd", record.cwd, canonicalize)) {
		throw new Error("Continuation child cwd does not match");
	}
	validateSessionAncestry(session.entries, record.childLeafId);
}

export class ContinuationLock {
	private readonly held = new Map<string, Set<string>>();

	async run<T>(
		parentSessionId: string,
		thread: string,
		operation: () => T | PromiseLike<T>,
		settlement?: (value: T) => PromiseLike<unknown> | undefined,
	): Promise<T> {
		assertParentSessionId(parentSessionId);
		validateContinuationThread(thread);
		let parentThreads = this.held.get(parentSessionId);
		if (!parentThreads) {
			parentThreads = new Set<string>();
			this.held.set(parentSessionId, parentThreads);
		}
		if (parentThreads.has(thread)) {
			throw new Error(`Continuation thread is already in use: ${thread}`);
		}
		parentThreads.add(thread);
		let releaseAfterSettlement = false;
		const release = () => {
			parentThreads.delete(thread);
			if (parentThreads.size === 0) this.held.delete(parentSessionId);
		};
		try {
			const value = await operation();
			const pendingSettlement = settlement?.(value);
			if (pendingSettlement !== undefined) {
				releaseAfterSettlement = true;
				void Promise.resolve(pendingSettlement).then(release, release);
			}
			return value;
		} finally {
			if (!releaseAfterSettlement) release();
		}
	}
}
