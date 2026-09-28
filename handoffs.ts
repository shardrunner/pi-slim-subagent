import {
	boundText,
	COMBINED_HANDOFF_MAX_BYTES,
	COMBINED_HANDOFF_MAX_LINES,
	FINAL_HANDOFF_MAX_BYTES,
	FINAL_HANDOFF_MAX_LINES,
} from "./sdk-runner-core.ts";
import { formatResultStatus, getCurrentOutput, isFailedResult, type SingleResult } from "./sdk-orchestration-core.ts";

/** Reserve every agent's status before sharing the remaining output budget fairly. */
export function formatParallelHandoff(results: readonly SingleResult[]): string {
	if (results.length === 0 || results.length > 8) throw new Error("Parallel handoff requires 1–8 results");
	const labels = results.map(
		(r, i) =>
			`${i + 1}. ${boundText(r.agent, { maxBytes: 256, maxLines: 1 })}: ${isFailedResult(r) ? "failed" : "completed"}${isFailedResult(r) ? ` (${boundText(formatResultStatus(r) ?? "failed", { maxBytes: 128, maxLines: 1 })})` : ""}`,
	);
	const summary = `Parallel: ${results.filter((r) => !isFailedResult(r)).length}/${results.length} succeeded\n${labels.join("\n")}\n\n`;
	// Each output section adds a short index header and separators; all agent identities are above.
	const overhead = results.map((_, i) => `### Result ${i + 1}\n\n\n\n`).join("");
	const maxBytes = Math.min(
		FINAL_HANDOFF_MAX_BYTES,
		Math.floor((COMBINED_HANDOFF_MAX_BYTES - Buffer.byteLength(summary + overhead)) / results.length),
	);
	const maxLines = Math.min(
		FINAL_HANDOFF_MAX_LINES,
		Math.floor((COMBINED_HANDOFF_MAX_LINES - summary.split("\n").length - results.length * 5) / results.length),
	);
	return (
		summary +
		results
			.map((r, i) => {
				const output = isFailedResult(r) ? r.errorMessage || r.stderr || getCurrentOutput(r) : getCurrentOutput(r);
				return `### Result ${i + 1}\n\n${boundText(output || "(no output)", { maxBytes, maxLines })}`;
			})
			.join("\n\n")
	);
}
