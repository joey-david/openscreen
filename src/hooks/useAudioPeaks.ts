import { useEffect, useRef, useState } from "react";
import { WebDemuxer } from "web-demuxer";
import { StreamingVideoDecoder } from "@/lib/exporter/streamingDecoder";

const PEAKS_PER_SECOND = 200;
const MAX_PEAK_PAIRS = 24_000;
const DECODE_BACKPRESSURE_LIMIT = 8;

function isRemoteUrl(videoUrl: string) {
	return /^(https?:|blob:|data:)/i.test(videoUrl);
}

async function loadSourceFile(videoUrl: string): Promise<File> {
	const source =
		!isRemoteUrl(videoUrl) && window.electronAPI
			? await StreamingVideoDecoder.loadLocalSourceFile(videoUrl)
			: await StreamingVideoDecoder.loadRemoteSourceFile(videoUrl);
	return source.file;
}

/** Decode one packet at a time and fold its samples into fixed timeline bins. */
async function computeAudioPeaks(videoUrl: string, signal: AbortSignal): Promise<Float32Array> {
	const file = await loadSourceFile(videoUrl);
	if (signal.aborted) throw new DOMException("Aborted", "AbortError");

	const wasmUrl = new URL("./wasm/web-demuxer.wasm", window.location.href).href;
	const demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });
	let decoder: AudioDecoder | null = null;
	try {
		await demuxer.load(file);
		const mediaInfo = await demuxer.getMediaInfo();
		const audioStream = mediaInfo.streams.find((stream) => stream.codec_type_string === "audio");
		if (!audioStream) return new Float32Array(0);

		const duration = Math.max(
			Number.isFinite(mediaInfo.duration) ? mediaInfo.duration : 0,
			typeof audioStream.duration === "number" && Number.isFinite(audioStream.duration)
				? audioStream.duration
				: 0,
		);
		if (duration <= 0) return new Float32Array(0);

		const decoderConfig = await demuxer.getDecoderConfig("audio");
		const support = await AudioDecoder.isConfigSupported(decoderConfig);
		if (!support.supported) throw new Error(`Unsupported audio codec: ${decoderConfig.codec}`);

		const pairCount = Math.min(MAX_PEAK_PAIRS, Math.max(1, Math.ceil(duration * PEAKS_PER_SECOND)));
		const peaks = new Float32Array(pairCount * 2);
		let decodeError: Error | null = null;
		decoder = new AudioDecoder({
			output: (data) => {
				try {
					const planes = Array.from(
						{ length: data.numberOfChannels },
						() => new Float32Array(data.numberOfFrames),
					);
					for (let channel = 0; channel < planes.length; channel += 1) {
						data.copyTo(planes[channel], { format: "f32-planar", planeIndex: channel });
					}

					const startSec = data.timestamp / 1_000_000;
					for (let frame = 0; frame < data.numberOfFrames; frame += 1) {
						let sample = 0;
						for (const plane of planes) sample += plane[frame] ?? 0;
						sample /= Math.max(1, planes.length);
						const timeSec = startSec + frame / data.sampleRate;
						const bin = Math.min(
							pairCount - 1,
							Math.max(0, Math.floor((timeSec / duration) * pairCount)),
						);
						const index = bin * 2;
						if (sample < peaks[index]) peaks[index] = sample;
						if (sample > peaks[index + 1]) peaks[index + 1] = sample;
					}
				} catch (error) {
					decodeError = error instanceof Error ? error : new Error(String(error));
				} finally {
					data.close();
				}
			},
			error: (error) => {
				decodeError = new Error(`AudioDecoder error: ${error.message}`);
			},
		});
		decoder.configure(decoderConfig);

		const reader = demuxer.read("audio", 0, duration + 0.5).getReader();
		try {
			while (!signal.aborted && !decodeError) {
				const { done, value } = await reader.read();
				if (done || !value) break;
				decoder.decode(value);
				while (decoder.decodeQueueSize > DECODE_BACKPRESSURE_LIMIT && !signal.aborted) {
					await new Promise((resolve) => setTimeout(resolve, 1));
				}
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}

		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		if (decodeError) throw decodeError;
		await decoder.flush();
		if (decodeError) throw decodeError;
		return peaks;
	} finally {
		if (decoder?.state === "configured") decoder.close();
		demuxer.destroy();
	}
}

/**
 * Returns paired [min, max] waveform peaks. The cache stores only the compact
 * peak array; source packets and decoded AudioData are released as they pass.
 */
export function useAudioPeaks(videoUrl?: string): Float32Array | null {
	const cacheRef = useRef<Map<string, Float32Array>>(new Map());
	const [peaks, setPeaks] = useState<Float32Array | null>(() =>
		videoUrl ? (cacheRef.current.get(videoUrl) ?? null) : null,
	);

	useEffect(() => {
		if (!videoUrl) {
			setPeaks(null);
			return;
		}

		const cached = cacheRef.current.get(videoUrl);
		if (cached) {
			setPeaks(cached);
			return;
		}

		setPeaks(null);
		const controller = new AbortController();
		void computeAudioPeaks(videoUrl, controller.signal)
			.then((nextPeaks) => {
				if (controller.signal.aborted) return;
				cacheRef.current.set(videoUrl, nextPeaks);
				setPeaks(nextPeaks);
			})
			.catch((error) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				console.warn("useAudioPeaks: could not decode audio for waveform:", error);
				if (!controller.signal.aborted) setPeaks(null);
			});

		return () => controller.abort();
	}, [videoUrl]);

	return peaks;
}
