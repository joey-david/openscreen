import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchWebmDurationOnDisk } from "./webm-duration";

const SEGMENT = [0x18, 0x53, 0x80, 0x67];
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const INFO = [0x15, 0x49, 0xa9, 0x66];
const TIMECODE_SCALE = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75, 0x81, 0xaa];

function makeWebm(duration?: number) {
	const durationBytes =
		duration === undefined
			? []
			: (() => {
					const bytes = Buffer.alloc(11);
					bytes.set([0x44, 0x89, 0x88]);
					bytes.writeDoubleBE(duration, 3);
					return [...bytes];
				})();
	const infoPayload = [...TIMECODE_SCALE, ...durationBytes];
	return Buffer.from([
		...SEGMENT,
		...UNKNOWN_SIZE,
		...INFO,
		0x80 | infoPayload.length,
		...infoPayload,
		...CLUSTER,
	]);
}

describe("patchWebmDurationOnDisk", () => {
	let dir: string;
	let filePath: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "openscreen-duration-"));
		filePath = path.join(dir, "recording.webm");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("inserts Duration while preserving the remaining media bytes", async () => {
		const original = makeWebm();
		await writeFile(filePath, original);

		expect(await patchWebmDurationOnDisk(filePath, 12_345)).toEqual({ patched: true });

		const patched = await readFile(filePath);
		expect(patched.length).toBe(original.length + 11);
		const durationOffset = patched.indexOf(Buffer.from([0x44, 0x89, 0x88]));
		expect(patched.readDoubleBE(durationOffset + 3)).toBe(12_345);
		expect(patched.subarray(-CLUSTER.length)).toEqual(Buffer.from(CLUSTER));
	});

	it("updates an invalid Duration in place", async () => {
		const original = makeWebm(0);
		await writeFile(filePath, original);

		expect(await patchWebmDurationOnDisk(filePath, 8_000)).toEqual({ patched: true });

		const patched = await readFile(filePath);
		expect(patched.length).toBe(original.length);
		const durationOffset = patched.indexOf(Buffer.from([0x44, 0x89, 0x88]));
		expect(patched.readDoubleBE(durationOffset + 3)).toBe(8_000);
	});

	it("leaves a valid Duration unchanged", async () => {
		const original = makeWebm(5_000);
		await writeFile(filePath, original);

		expect(await patchWebmDurationOnDisk(filePath, 8_000)).toEqual({
			patched: false,
			reason: "already-valid",
		});
		expect(await readFile(filePath)).toEqual(original);
	});
});
