import { describe, expect, it } from "vitest";
import { getAudioTrackStartTime } from "./mp4-audio-timing";

function trackWithEdits(
	edits: Array<{ segment_duration: number; media_time: number }>,
	movieTimescale = 48_000,
) {
	return {
		edits: edits.map((edit) => ({
			...edit,
			media_rate_integer: 1,
			media_rate_fraction: 0,
		})),
		movie_timescale: movieTimescale,
	} as Parameters<typeof getAudioTrackStartTime>[0];
}

describe("getAudioTrackStartTime", () => {
	it("reads the leading empty edit as the track delay", () => {
		const track = trackWithEdits([
			{ segment_duration: 19_499, media_time: -1 },
			{ segment_duration: 292_352, media_time: 2_112 },
		]);

		expect(getAudioTrackStartTime(track)).toBeCloseTo(0.406229, 6);
	});

	it("does not treat a media trim as a start delay", () => {
		const track = trackWithEdits([{ segment_duration: 312_800, media_time: 590 }]);

		expect(getAudioTrackStartTime(track)).toBe(0);
	});
});
