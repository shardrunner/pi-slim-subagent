export interface RunSlot {
	(): void;
	/** Reserve this slot for work that outlived its result, without pretending it stopped. */
	quarantine(): void;
}

const QUARANTINED_MESSAGE =
	"Subagent capacity is quarantined by unsettled work; this task was not started. Wait for cleanup or inspect /agents before retrying.";

/** FIFO, abortable admission control shared by all dispatches in this module instance. */
export class RunScheduler {
	private active = 0;
	private quarantined = 0;
	private readonly queue: Array<{ admit(): void; fail(error: Error): void }> = [];
	readonly limit: number;
	constructor(limit: number) {
		this.limit = limit;
		if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency limit must be a positive integer");
	}
	acquire(signal?: AbortSignal): Promise<RunSlot> {
		if (signal?.aborted) return Promise.reject(new Error("Subagent was aborted while queued"));
		if (this.quarantined === this.limit) return Promise.reject(new Error(QUARANTINED_MESSAGE));
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				const index = this.queue.indexOf(entry);
				if (index >= 0) this.queue.splice(index, 1);
				entry.fail(new Error("Subagent was aborted while queued"));
			};
			const entry = {
				fail: (error: Error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				admit: () => {
					signal?.removeEventListener("abort", onAbort);
					this.active++;
					let released = false;
					let quarantined = false;
					const release = Object.assign(
						() => {
							if (released) return;
							released = true;
							this.active--;
							if (quarantined) this.quarantined--;
							this.queue.shift()?.admit();
						},
						{
							quarantine: () => {
								if (released || quarantined) return;
								quarantined = true;
								this.quarantined++;
								if (this.quarantined === this.limit) {
									for (const waiting of this.queue.splice(0)) waiting.fail(new Error(QUARANTINED_MESSAGE));
								}
							},
						},
					);
					resolve(release);
				},
			};
			if (this.active < this.limit) entry.admit();
			else {
				this.queue.push(entry);
				signal?.addEventListener("abort", onAbort, { once: true });
			}
		});
	}
}

export const sharedScheduler = new RunScheduler(4);
