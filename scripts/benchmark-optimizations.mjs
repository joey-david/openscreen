import { execFile } from "node:child_process";
import { copyFile, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const durationMs = 60_000;

function readNumberArg(name, fallback) {
	const index = process.argv.indexOf(name);
	if (index === -1) return fallback;
	const value = Number(process.argv[index + 1]);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
	return Math.round(value);
}

function encodeVint(value) {
	const numeric = BigInt(value);
	for (let length = 1; length <= 8; length += 1) {
		const max = (1n << BigInt(7 * length)) - 2n;
		if (numeric > max) continue;
		const bytes = Buffer.alloc(length);
		let rest = numeric;
		for (let index = length - 1; index >= 0; index -= 1) {
			bytes[index] = Number(rest & 0xffn);
			rest >>= 8n;
		}
		bytes[0] |= 1 << (8 - length);
		return bytes;
	}
	throw new Error("EBML value is too large");
}

async function createFixture(filePath, sizeBytes) {
	const segment = Buffer.from([
		0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	]);
	const timecodeScale = Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);
	// Streamed MediaRecorder WebM files can omit Duration, so use the stricter
	// path where both versions must publish a rewritten file.
	const infoPayload = timecodeScale;
	const info = Buffer.concat([
		Buffer.from([0x15, 0x49, 0xa9, 0x66]),
		encodeVint(infoPayload.length),
		infoPayload,
	]);
	const cluster = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x81, 0xaa]);
	const fixedBytes = segment.length + info.length + cluster.length + 6;
	const voidBytes = Math.max(1, sizeBytes - fixedBytes);
	const voidHeader = Buffer.concat([Buffer.from([0xec]), encodeVint(voidBytes)]);
	const handle = await open(filePath, "w");
	const chunk = Buffer.alloc(4 * 1024 * 1024);
	for (let index = 0; index < chunk.length; index += 4096) chunk[index] = (index / 4096) & 0xff;
	try {
		await handle.write(segment);
		await handle.write(info);
		await handle.write(voidHeader);
		let remaining = voidBytes;
		while (remaining > 0) {
			const length = Math.min(remaining, chunk.length);
			await handle.write(chunk, 0, length);
			remaining -= length;
		}
		await handle.write(cluster);
	} finally {
		await handle.close();
	}
}

async function runWorker() {
	const mode = process.argv[3];
	const sourcePath = process.argv[4];
	const outputPath = process.argv[5];
	const modulePath = process.argv[6];
	const started = performance.now();

	if (mode === "webm") {
		const module = await import(pathToFileURL(modulePath));
		const result = await module.patchWebmDurationOnDisk(sourcePath, durationMs);
		if (!result.patched) throw new Error(`Duration patch failed: ${JSON.stringify(result)}`);
	} else if (mode === "copy-before") {
		const mainBytes = await readFile(sourcePath);
		const rendererBytes = mainBytes.buffer.slice(
			mainBytes.byteOffset,
			mainBytes.byteOffset + mainBytes.byteLength,
		);
		const blob = new Blob([rendererBytes], { type: "video/mp4" });
		const exportBytes = await blob.arrayBuffer();
		await writeFile(outputPath, Buffer.from(exportBytes));
	} else if (mode === "copy-after") {
		const module = await import(pathToFileURL(modulePath));
		const registry = new module.ExportStreamRegistry();
		await registry.copyFrom(sourcePath, outputPath);
	} else {
		throw new Error(`Unknown worker mode: ${mode}`);
	}

	const elapsedMs = performance.now() - started;
	console.log(JSON.stringify({ elapsedMs, peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
}

async function bundle(entryPoint, outfile) {
	await build({
		entryPoints: [entryPoint],
		outfile,
		absWorkingDir: repoRoot,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		nodePaths: [path.join(repoRoot, "node_modules")],
		logLevel: "silent",
	});
}

async function runChild(args) {
	const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--worker", ...args], {
		cwd: repoRoot,
		maxBuffer: 1024 * 1024,
	});
	const line = stdout.trim().split("\n").at(-1);
	return JSON.parse(line);
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function summarize(samples) {
	return {
		elapsedMs: median(samples.map((sample) => sample.elapsedMs)),
		peakRssMiB: median(samples.map((sample) => sample.peakRssMiB)),
	};
}

function formatTime(milliseconds) {
	return milliseconds >= 1000
		? `${(milliseconds / 1000).toFixed(2)} s`
		: `${milliseconds.toFixed(1)} ms`;
}

function formatMemory(mebibytes) {
	return `${Math.round(mebibytes)} MiB`;
}

async function runBenchmark() {
	const sizeMiB = readNumberArg("--size-mib", 256);
	const runs = readNumberArg("--runs", 3);
	const tempDir = await mkdtemp(path.join(tmpdir(), "openscreen-benchmark-"));
	try {
		const fixturePath = path.join(tempDir, "fixture.webm");
		const oldSourcePath = path.join(tempDir, "webm-duration-before.ts");
		const oldBundlePath = path.join(tempDir, "webm-duration-before.mjs");
		const newBundlePath = path.join(tempDir, "webm-duration-after.mjs");
		const exportBundlePath = path.join(tempDir, "export-stream-after.mjs");
		const baselineRef =
			process.env.OPENSCREEN_BENCHMARK_BASE ?? "f57e36e25448b5af6c7b1b271066fe5beb9b8a49";
		const { stdout: parentCommitOutput } = await execFileAsync("git", ["rev-parse", baselineRef], {
			cwd: repoRoot,
		});
		const parentCommit = parentCommitOutput.trim();
		const { stdout: oldSource } = await execFileAsync(
			"git",
			["show", `${parentCommit}:electron/recording/webm-duration.ts`],
			{ cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 },
		);
		await writeFile(oldSourcePath, oldSource);
		await Promise.all([
			bundle(oldSourcePath, oldBundlePath),
			bundle(path.join(repoRoot, "electron/recording/webm-duration.ts"), newBundlePath),
			bundle(path.join(repoRoot, "electron/ipc/exportStream.ts"), exportBundlePath),
		]);
		await createFixture(fixturePath, sizeMiB * 1024 * 1024);
		const fixtureSize = (await stat(fixturePath)).size;

		const results = {
			webmBefore: [],
			webmAfter: [],
			copyBefore: [],
			copyAfter: [],
		};
		for (let run = 0; run < runs; run += 1) {
			const oldWebmPath = path.join(tempDir, `before-${run}.webm`);
			const newWebmPath = path.join(tempDir, `after-${run}.webm`);
			const oldExportPath = path.join(tempDir, `before-${run}.mp4`);
			const newExportPath = path.join(tempDir, `after-${run}.mp4`);
			await copyFile(fixturePath, oldWebmPath);
			await copyFile(fixturePath, newWebmPath);
			results.webmBefore.push(await runChild(["webm", oldWebmPath, "-", oldBundlePath]));
			results.webmAfter.push(await runChild(["webm", newWebmPath, "-", newBundlePath]));
			results.copyBefore.push(await runChild(["copy-before", fixturePath, oldExportPath, "-"]));
			results.copyAfter.push(
				await runChild(["copy-after", fixturePath, newExportPath, exportBundlePath]),
			);
			for (const output of [oldWebmPath, newWebmPath, oldExportPath, newExportPath]) {
				await rm(output, { force: true });
			}
		}

		const cases = [
			{
				name: "Finish streamed WebM",
				before: summarize(results.webmBefore),
				after: summarize(results.webmAfter),
			},
			{
				name: "Export unchanged MP4",
				before: summarize(results.copyBefore),
				after: summarize(results.copyAfter),
			},
		];
		const { stdout: osName } = await execFileAsync("sw_vers", ["-productVersion"]).catch(() => ({
			stdout: process.platform,
		}));
		console.log(`OpenScreen benchmark: ${parentCommit.slice(0, 7)} -> working tree`);
		console.log(
			`${(fixtureSize / 1024 / 1024).toFixed(0)} MiB fixture, median of ${runs}, ${process.arch}, ${osName.trim()}, Node ${process.version}`,
		);
		console.log(
			"| Path | Before time | After time | Speedup | Before peak RSS | After peak RSS | RSS drop |",
		);
		console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
		for (const entry of cases) {
			const speedup = entry.before.elapsedMs / entry.after.elapsedMs;
			const memoryDrop = (1 - entry.after.peakRssMiB / entry.before.peakRssMiB) * 100;
			console.log(
				`| ${entry.name} | ${formatTime(entry.before.elapsedMs)} | ${formatTime(entry.after.elapsedMs)} | ${speedup.toFixed(1)}x | ${formatMemory(entry.before.peakRssMiB)} | ${formatMemory(entry.after.peakRssMiB)} | ${memoryDrop.toFixed(0)}% |`,
			);
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--worker") await runWorker();
else await runBenchmark();
