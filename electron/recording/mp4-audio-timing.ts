import fs from "node:fs/promises";
import { createFile, type Movie, MP4BoxBuffer } from "mp4box";

const MP4_PARSE_CHUNK_BYTES = 64 * 1024;

export interface Mp4AudioTrackTiming {
	bitrate: number;
	startTime: number;
}

export function getAudioTrackStartTime(track: Movie["audioTracks"][number]): number {
	let emptyEditDuration = 0;
	for (const edit of track.edits ?? []) {
		if (edit.media_time !== -1) break;
		emptyEditDuration += edit.segment_duration;
	}

	return track.movie_timescale > 0 ? emptyEditDuration / track.movie_timescale : 0;
}

export async function readMp4AudioTrackTimings(filePath: string): Promise<Mp4AudioTrackTiming[]> {
	const file = await fs.open(filePath, "r");
	try {
		const fileSize = (await file.stat()).size;
		const parser = createFile();
		let isReady = false;
		let parseError: Error | null = null;
		parser.onReady = () => {
			isReady = true;
		};
		parser.onError = (_module, message) => {
			parseError = new Error(message);
		};

		let fileOffset = 0;
		while (fileOffset < fileSize && !isReady && !parseError) {
			const byteLength = Math.min(MP4_PARSE_CHUNK_BYTES, fileSize - fileOffset);
			const bytes = Buffer.allocUnsafe(byteLength);
			const { bytesRead } = await file.read(bytes, 0, byteLength, fileOffset);
			if (bytesRead === 0) break;

			const buffer = MP4BoxBuffer.fromArrayBuffer(
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytesRead),
				fileOffset,
			);
			const nextOffset = parser.appendBuffer(buffer);
			const readEnd = fileOffset + bytesRead;
			fileOffset = Number.isFinite(nextOffset) && nextOffset > readEnd ? nextOffset : readEnd;
		}

		if (parseError) throw parseError;
		if (!isReady) throw new Error("MP4 track metadata is missing");
		const movie = parser.getInfo();

		return movie.audioTracks.map((track) => ({
			bitrate: Number.isFinite(track.bitrate) ? track.bitrate : 0,
			startTime: getAudioTrackStartTime(track),
		}));
	} finally {
		await file.close();
	}
}
