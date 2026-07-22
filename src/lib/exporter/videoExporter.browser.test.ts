import { describe, expect, it } from "vitest";
import sampleVideoUrl from "../../../tests/fixtures/sample.webm?url";
import { BackgroundLoadError } from "../wallpaper";
import type { ExportProgress } from "./types";
import { VideoExporter } from "./videoExporter";

describe("VideoExporter (real browser)", () => {
	it("exports a valid MP4 blob from a real video", async () => {
		const progressEvents: ExportProgress[] = [];

		const exporter = new VideoExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
			wallpaper: "#1a1a2e",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			onProgress: (p) => progressEvents.push(p),
		});

		const result = await exporter.export();

		expect(result.success, result.error).toBe(true);
		expect(result.blob).toBeInstanceOf(Blob);

		const buf = await result.blob!.arrayBuffer();
		const bytes = new Uint8Array(buf);
		const ftyp = new TextDecoder().decode(bytes.slice(4, 8));
		expect(ftyp).toBe("ftyp");

		expect(result.blob!.size).toBeGreaterThan(1024);

		expect(progressEvents.length).toBeGreaterThan(0);

		const finalizing = progressEvents.filter((p) => p.phase === "finalizing");
		expect(finalizing.length).toBeGreaterThan(0);
		expect(finalizing.at(-1)!.percentage).toBe(100);
	});

	it("streams MP4 output to the chosen file path without building a result blob", async () => {
		const writes: Array<{ position: number; data: Uint8Array }> = [];
		const previousApi = window.electronAPI;
		window.electronAPI = {
			readBinaryFile: async (filePath) => {
				const response = await fetch(filePath);
				return { success: true, data: await response.arrayBuffer(), path: filePath };
			},
			openExportStream: async () => ({ success: true }),
			writeExportChunk: async (_path, data, position) => {
				writes.push({ position, data: data.slice() });
				return { success: true };
			},
			closeExportStream: async () => ({ success: true }),
		} as Window["electronAPI"];

		try {
			const exporter = new VideoExporter({
				videoUrl: sampleVideoUrl,
				outputPath: "/tmp/openscreen-browser-test.mp4",
				width: 320,
				height: 180,
				frameRate: 15,
				bitrate: 1_000_000,
				wallpaper: "#1a1a2e",
				zoomRegions: [],
				showShadow: false,
				shadowIntensity: 0,
				showBlur: false,
				cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			});

			const result = await exporter.export();
			expect(result.success, result.error).toBe(true);
			expect(result.savedToPath).toBe("/tmp/openscreen-browser-test.mp4");
			expect(result.blob).toBeUndefined();

			const size = writes.reduce(
				(max, write) => Math.max(max, write.position + write.data.byteLength),
				0,
			);
			const bytes = new Uint8Array(size);
			for (const write of writes) bytes.set(write.data, write.position);
			expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe("ftyp");
			expect(bytes.byteLength).toBeGreaterThan(1024);
		} finally {
			window.electronAPI = previousApi;
		}
	});

	it("exports successfully with an image wallpaper (served by Vite dev server)", async () => {
		const exporter = new VideoExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
			wallpaper: "/wallpapers/wallpaper1.jpg",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});

		const result = await exporter.export();
		expect(result.success, result.error).toBe(true);
		expect(result.blob!.size).toBeGreaterThan(1024);
	});

	it("throws BackgroundLoadError when wallpaper fails to load (no silent black fallback)", async () => {
		const exporter = new VideoExporter({
			videoUrl: sampleVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
			wallpaper: "/wallpapers/does-not-exist.jpg",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});

		const rejection = exporter.export();
		await expect(rejection).rejects.toBeInstanceOf(BackgroundLoadError);
		await expect(rejection).rejects.toMatchObject({
			url: expect.stringContaining("does-not-exist"),
		});
	});
});
