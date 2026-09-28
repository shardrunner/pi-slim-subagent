interface ToolResultMessage {
	role: "toolResult";
	details?: { added?: string[] };
}

interface MessageEntry {
	type: "message";
	message: ToolResultMessage;
}

function isToolResultMessageEntry(entry: unknown): entry is MessageEntry {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as { type?: unknown; message?: { role?: unknown; details?: unknown } };
	if (candidate.type !== "message" || candidate.message?.role !== "toolResult") return false;
	const details = candidate.message.details;
	if (details === undefined) return true;
	if (details === null || typeof details !== "object" || Array.isArray(details)) return false;
	const added = (details as { added?: unknown }).added;
	return added === undefined || (Array.isArray(added) && added.every((name) => typeof name === "string"));
}

export function wasToolDynamicallyLoaded(entries: readonly unknown[], toolName: string): boolean {
	return entries.some(
		(entry) => isToolResultMessageEntry(entry) && (entry.message.details?.added ?? []).includes(toolName),
	);
}

export function reconcileDynamicallyLoadedTool(
	entries: readonly unknown[],
	activeTools: string[],
	loaderToolName: string,
	loadedToolName: string,
): string[] {
	if (!activeTools.includes(loaderToolName)) return activeTools;

	const shouldBeActive = wasToolDynamicallyLoaded(entries, loadedToolName);
	const isActive = activeTools.includes(loadedToolName);
	if (shouldBeActive === isActive) return activeTools;
	return shouldBeActive
		? [...new Set([...activeTools, loadedToolName])]
		: activeTools.filter((name) => name !== loadedToolName);
}

export function reconcileDynamicallyLoadedTools(
	entries: readonly unknown[],
	activeTools: string[],
	loaderToolName: string,
	loadedToolNames: readonly string[],
): string[] {
	return loadedToolNames.reduce(
		(active, loadedToolName) => reconcileDynamicallyLoadedTool(entries, active, loaderToolName, loadedToolName),
		activeTools,
	);
}
