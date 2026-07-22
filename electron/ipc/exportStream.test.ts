import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExportStreamRegistry } from "./exportStream";

describe("ExportStreamRegistry", () => {
	let dir: string;
	let outputPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "openscreen-export-"));
		outputPath = path.join(dir, "output.mp4");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("supports positional writes and publishes only on finalize", async () => {
		const registry = new ExportStreamRegistry();
		await registry.open(outputPath);
		await registry.write(outputPath, new Uint8Array([4, 5]), 3);
		await registry.write(outputPath, new Uint8Array([1, 2, 3]), 0);
		await expect(readFile(outputPath)).rejects.toThrow();

		await registry.finalize(outputPath);

		expect(await readFile(outputPath)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
	});

	it("keeps an existing output until the new export completes", async () => {
		await writeFile(outputPath, "old");
		const registry = new ExportStreamRegistry();
		await registry.open(outputPath);
		await registry.write(outputPath, new TextEncoder().encode("new"), 0);
		expect(await readFile(outputPath, "utf8")).toBe("old");

		await registry.finalize(outputPath);
		expect(await readFile(outputPath, "utf8")).toBe("new");
	});

	it("removes a failed temp export without touching the old output", async () => {
		await writeFile(outputPath, "old");
		const registry = new ExportStreamRegistry();
		await registry.open(outputPath);
		await registry.write(outputPath, new TextEncoder().encode("partial"), 0);
		await registry.discard(outputPath);

		expect(await readFile(outputPath, "utf8")).toBe("old");
	});

	it("copies an unchanged source without routing its bytes through the renderer", async () => {
		const sourcePath = path.join(dir, "source.mp4");
		await writeFile(sourcePath, "source-video");
		const registry = new ExportStreamRegistry();

		await registry.copyFrom(sourcePath, outputPath);

		expect(await readFile(outputPath, "utf8")).toBe("source-video");
	});
});
