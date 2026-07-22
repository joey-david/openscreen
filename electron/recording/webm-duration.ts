import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";

export type DurationPatchResult =
	| { patched: true }
	| { patched: false; reason: "no-section" | "already-valid" | "io-error" | "internal" };

const HEADER_READ_LIMIT = 4 * 1024 * 1024;
const COPY_BUFFER_SIZE = 1024 * 1024;
const SEGMENT_ID = 0x18538067;
const INFO_ID = 0x1549a966;
const TIMECODE_SCALE_ID = 0x2ad7b1;
const DURATION_ID = 0x4489;

type Vint = { width: number; value: bigint; unknown: boolean };
type Element = {
	id: number;
	size: Vint;
	sizeOffset: number;
	dataOffset: number;
	endOffset: number;
};

function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): Vint | null {
	const first = bytes[offset];
	if (first === undefined || first === 0) return null;

	let width = 1;
	let marker = 0x80;
	while (width <= 8 && (first & marker) === 0) {
		width += 1;
		marker >>= 1;
	}
	if (width > 8 || offset + width > bytes.length) return null;

	let value = BigInt(keepMarker ? first : first & (marker - 1));
	for (let index = 1; index < width; index += 1) {
		value = (value << 8n) | BigInt(bytes[offset + index]);
	}
	const maxValue = (1n << BigInt(7 * width)) - 1n;
	return { width, value, unknown: !keepMarker && value === maxValue };
}

function readElement(bytes: Uint8Array, offset: number): Element | null {
	const id = readVint(bytes, offset, true);
	if (!id || id.width > 4) return null;
	const sizeOffset = offset + id.width;
	const size = readVint(bytes, sizeOffset, false);
	if (!size) return null;

	const dataOffset = sizeOffset + size.width;
	const endOffset = size.unknown ? Number.POSITIVE_INFINITY : dataOffset + Number(size.value);
	return { id: Number(id.value), size, sizeOffset, dataOffset, endOffset };
}

function findChild(
	bytes: Uint8Array,
	start: number,
	end: number,
	targetId: number,
): Element | null {
	let offset = start;
	while (offset < end && offset < bytes.length) {
		const element = readElement(bytes, offset);
		if (!element) return null;
		if (element.id === targetId) return element;
		if (!Number.isFinite(element.endOffset) || element.endOffset <= offset) return null;
		offset = element.endOffset;
	}
	return null;
}

function encodeSize(value: bigint, width: number): Uint8Array | null {
	const maxValue = (1n << BigInt(7 * width)) - 2n;
	if (value < 0 || value > maxValue) return null;

	let encoded = value | (1n << BigInt(7 * width));
	const bytes = new Uint8Array(width);
	for (let index = width - 1; index >= 0; index -= 1) {
		bytes[index] = Number(encoded & 0xffn);
		encoded >>= 8n;
	}
	return bytes;
}

function readUnsigned(bytes: Uint8Array, element: Element): number | null {
	const length = element.endOffset - element.dataOffset;
	if (!Number.isFinite(length) || length < 1 || length > 8 || element.endOffset > bytes.length) {
		return null;
	}
	let value = 0n;
	for (let offset = element.dataOffset; offset < element.endOffset; offset += 1) {
		value = (value << 8n) | BigInt(bytes[offset]);
	}
	return Number(value);
}

function readFloat(bytes: Uint8Array, element: Element): number | null {
	const length = element.endOffset - element.dataOffset;
	if (element.endOffset > bytes.length || (length !== 4 && length !== 8)) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataOffset, length);
	return length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
}

function writeFloat(bytes: Uint8Array, element: Element, value: number): boolean {
	const length = element.endOffset - element.dataOffset;
	if (element.endOffset > bytes.length || (length !== 4 && length !== 8)) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataOffset, length);
	if (length === 4) view.setFloat32(0, value, false);
	else view.setFloat64(0, value, false);
	return true;
}

async function copyRemainder(
	source: FileHandle,
	target: FileHandle,
	sourceStart: number,
	targetStart: number,
	fileSize: number,
): Promise<void> {
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
	let readPosition = sourceStart;
	let writePosition = targetStart;
	while (readPosition < fileSize) {
		const toRead = Math.min(buffer.length, fileSize - readPosition);
		const { bytesRead } = await source.read(buffer, 0, toRead, readPosition);
		if (bytesRead === 0) break;
		await target.write(buffer, 0, bytesRead, writePosition);
		readPosition += bytesRead;
		writePosition += bytesRead;
	}
}

/**
 * Add or update WebM Duration without holding the recording in memory.
 *
 * MediaRecorder places Segment/Info near the start. We parse at most 4 MiB,
 * patch an existing float in place, or insert an 11-byte Duration element and
 * stream the rest through an atomic temp file. Peak memory stays bounded for
 * short and multi-hour recordings alike.
 */
export async function patchWebmDurationOnDisk(
	filePath: string,
	durationMs: number,
): Promise<DurationPatchResult> {
	const tmpPath = `${filePath}.duration-patch.tmp`;
	let source: FileHandle | null = null;
	let target: FileHandle | null = null;
	try {
		source = await fs.open(filePath, "r+");
		const stats = await source.stat();
		const header = Buffer.allocUnsafe(Math.min(stats.size, HEADER_READ_LIMIT));
		const { bytesRead } = await source.read(header, 0, header.length, 0);
		const bytes = new Uint8Array(header.buffer, header.byteOffset, bytesRead);

		const segment = findChild(bytes, 0, bytes.length, SEGMENT_ID);
		if (!segment) return { patched: false, reason: "no-section" };
		const segmentEnd = segment.size.unknown
			? bytes.length
			: Math.min(segment.endOffset, bytes.length);
		const info = findChild(bytes, segment.dataOffset, segmentEnd, INFO_ID);
		if (!info || !Number.isFinite(info.endOffset) || info.endOffset > bytes.length) {
			return { patched: false, reason: "no-section" };
		}

		const timecodeScale = findChild(bytes, info.dataOffset, info.endOffset, TIMECODE_SCALE_ID);
		const scale = timecodeScale ? readUnsigned(bytes, timecodeScale) : 1_000_000;
		if (!scale || !Number.isFinite(scale)) return { patched: false, reason: "internal" };
		const durationUnits = (durationMs * 1_000_000) / scale;
		const duration = findChild(bytes, info.dataOffset, info.endOffset, DURATION_ID);

		if (duration) {
			const currentValue = readFloat(bytes, duration);
			if (currentValue !== null && currentValue > 0) {
				return { patched: false, reason: "already-valid" };
			}
			if (!writeFloat(bytes, duration, durationUnits)) {
				return { patched: false, reason: "internal" };
			}
			await source.write(
				header,
				duration.dataOffset,
				duration.endOffset - duration.dataOffset,
				duration.dataOffset,
			);
			return { patched: true };
		}

		const durationElement = Buffer.allocUnsafe(11);
		durationElement.set([0x44, 0x89, 0x88], 0);
		durationElement.writeDoubleBE(durationUnits, 3);
		const addedBytes = BigInt(durationElement.length);
		const infoSize = encodeSize(info.size.value + addedBytes, info.size.width);
		const segmentSize = segment.size.unknown
			? null
			: encodeSize(segment.size.value + addedBytes, segment.size.width);
		if (!infoSize || (!segment.size.unknown && !segmentSize)) {
			return { patched: false, reason: "internal" };
		}

		const prefix = Buffer.from(bytes.subarray(0, info.endOffset));
		prefix.set(infoSize, info.sizeOffset);
		if (segmentSize) prefix.set(segmentSize, segment.sizeOffset);

		target = await fs.open(tmpPath, "w");
		await target.write(prefix, 0, prefix.length, 0);
		await target.write(durationElement, 0, durationElement.length, prefix.length);
		await copyRemainder(
			source,
			target,
			info.endOffset,
			prefix.length + durationElement.length,
			stats.size,
		);
		await target.sync();
		await target.close();
		target = null;
		await source.close();
		source = null;
		await fs.rename(tmpPath, filePath);
		return { patched: true };
	} catch (error) {
		console.error(`[webm-duration] failed to patch ${filePath}:`, error);
		return { patched: false, reason: "io-error" };
	} finally {
		await target?.close().catch(() => undefined);
		await source?.close().catch(() => undefined);
		await fs.unlink(tmpPath).catch(() => undefined);
	}
}
