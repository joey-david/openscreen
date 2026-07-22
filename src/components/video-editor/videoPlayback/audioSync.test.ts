import { describe, expect, it } from "vitest";
import { getSupplementalAudioPosition } from "./audioSync";

describe("getSupplementalAudioPosition", () => {
	it("holds delayed audio until its source start time", () => {
		expect(getSupplementalAudioPosition(0.2, 0.4)).toEqual({
			currentTime: 0,
			shouldPlay: false,
		});
	});

	it("maps the video clock to the extracted audio clock", () => {
		const position = getSupplementalAudioPosition(1.4, 0.4);

		expect(position.currentTime).toBeCloseTo(1);
		expect(position.shouldPlay).toBe(true);
	});
});
