export interface SupplementalAudioPosition {
	currentTime: number;
	shouldPlay: boolean;
}

export function getSupplementalAudioPosition(
	videoTime: number,
	audioStartTime: number,
): SupplementalAudioPosition {
	const safeVideoTime = Number.isFinite(videoTime) ? Math.max(0, videoTime) : 0;
	const safeStartTime = Number.isFinite(audioStartTime) ? Math.max(0, audioStartTime) : 0;
	return {
		currentTime: Math.max(0, safeVideoTime - safeStartTime),
		shouldPlay: safeVideoTime >= safeStartTime,
	};
}
