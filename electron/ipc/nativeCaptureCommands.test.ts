import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	guardNativeCaptureCommandChannel,
	observeNativeMacCaptureStopEvent,
	sendNativeCaptureCommand,
} from "./nativeCaptureCommands";

describe("native capture commands", () => {
	it("writes newline-delimited helper commands", async () => {
		const stdin = new PassThrough();
		const chunks: string[] = [];
		stdin.on("data", (chunk) => chunks.push(chunk.toString()));

		await sendNativeCaptureCommand({ stdin } as never, "stop");

		expect(chunks).toEqual(["stop\n"]);
	});

	it("rejects a closed command channel without writing", async () => {
		const stdin = new PassThrough();
		stdin.end();

		await expect(sendNativeCaptureCommand({ stdin } as never, "pause")).rejects.toThrow(
			"command channel is closed",
		);
	});

	it("turns an asynchronous pipe failure into a rejected command", async () => {
		const pipeError = new Error("write EPIPE");
		const stdin = new Writable({
			write(_chunk, _encoding, callback) {
				callback(pipeError);
			},
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		guardNativeCaptureCommandChannel({ stdin } as never, "native-test");

		await expect(sendNativeCaptureCommand({ stdin } as never, "resume")).rejects.toThrow(
			"write EPIPE",
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(warn).toHaveBeenCalledWith("[native-test] command channel closed:", pipeError);
		warn.mockRestore();
	});

	it("lets a successful stop event recover an earlier helper error", () => {
		const state = { terminalError: null as Error | null };
		expect(
			observeNativeMacCaptureStopEvent(
				state,
				{ event: "error", message: "capture interrupted" },
				"fallback.mp4",
			),
		).toBeNull();
		expect(state.terminalError?.message).toBe("capture interrupted");

		expect(
			observeNativeMacCaptureStopEvent(
				state,
				{ event: "recording-stopped", screenPath: "saved.mp4" },
				"fallback.mp4",
			),
		).toBe("saved.mp4");
	});
});
