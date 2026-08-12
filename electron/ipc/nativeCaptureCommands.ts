import type { ChildProcessWithoutNullStreams } from "node:child_process";

type NativeCaptureProcess = Pick<ChildProcessWithoutNullStreams, "stdin">;

export type NativeMacCaptureStopState = {
	terminalError: Error | null;
};

const guardedInputs = new WeakSet<ChildProcessWithoutNullStreams["stdin"]>();

/** Keep a closed helper pipe from becoming an uncaught main-process EPIPE. */
export function guardNativeCaptureCommandChannel(
	proc: NativeCaptureProcess,
	logPrefix: string,
): void {
	if (guardedInputs.has(proc.stdin)) {
		return;
	}

	guardedInputs.add(proc.stdin);
	proc.stdin.on("error", (error) => {
		console.warn(`[${logPrefix}] command channel closed:`, error);
	});
}

/** Send one line to a native helper and wait until Node flushes or rejects it. */
export function sendNativeCaptureCommand(
	proc: NativeCaptureProcess,
	command: "pause" | "resume" | "stop",
): Promise<void> {
	if (!proc.stdin.writable) {
		return Promise.reject(new Error("Native capture command channel is closed."));
	}

	return new Promise<void>((resolve, reject) => {
		try {
			proc.stdin.write(`${command}\n`, (error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		} catch (error) {
			reject(error);
		}
	});
}

/** Record helper errors but let a later recording-stopped event win. */
export function observeNativeMacCaptureStopEvent(
	state: NativeMacCaptureStopState,
	event: Record<string, unknown>,
	fallbackPath: string | null,
): string | null {
	if (event.event === "recording-stopped") {
		return String(event.screenPath ?? fallbackPath ?? "");
	}
	if (event.event === "error") {
		state.terminalError = new Error(
			String(event.message ?? event.code ?? "Native macOS capture failed"),
		);
	}
	return null;
}
