import {
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedVideoPacketSource,
	Mp4OutputFormat,
	Output,
	StreamTarget,
	type StreamTargetChunk,
} from "mediabunny";
import type { ExportConfig } from "./types";

export type ExportAudioMuxerCodec = "aac" | "opus";

export class VideoMuxer {
	private output: Output | null = null;
	private videoSource: EncodedVideoPacketSource | null = null;
	private audioSource: EncodedAudioPacketSource | null = null;
	private hasAudio: boolean;
	private target: BufferTarget | StreamTarget | null = null;
	private config: ExportConfig;
	private audioCodec: ExportAudioMuxerCodec;
	private outputPath?: string;
	private streamOpen = false;
	private streamFinalized = false;

	constructor(
		config: ExportConfig,
		hasAudio = false,
		audioCodec: ExportAudioMuxerCodec = "aac",
		outputPath?: string,
	) {
		this.config = config;
		this.hasAudio = hasAudio;
		this.audioCodec = audioCodec;
		this.outputPath = outputPath;
	}

	async initialize(): Promise<void> {
		const api = window.electronAPI;
		const canStream = Boolean(
			this.outputPath && api?.openExportStream && api.writeExportChunk && api.closeExportStream,
		);
		if (canStream && this.outputPath) {
			const outputPath = this.outputPath;
			const opened = await api.openExportStream!(outputPath);
			if (!opened.success) throw new Error(opened.error ?? "Failed to open export output");
			this.streamOpen = true;
			const writable = new WritableStream<StreamTargetChunk>({
				write: async ({ data, position }) => {
					const result = await api.writeExportChunk!(outputPath, data, position);
					if (!result.success) throw new Error(result.error ?? "Failed to write export output");
				},
				close: async () => {
					const result = await api.closeExportStream!(outputPath, false);
					if (!result.success) throw new Error(result.error ?? "Failed to finish export output");
					this.streamOpen = false;
					this.streamFinalized = true;
				},
				abort: async () => {
					await api.closeExportStream!(outputPath, true).catch(() => undefined);
					this.streamOpen = false;
				},
			});
			this.target = new StreamTarget(writable, { chunked: true });
		} else {
			this.target = new BufferTarget();
		}

		this.output = new Output({
			format: new Mp4OutputFormat({
				// A file stream uses regular MP4 metadata at the end: fastest and bounded.
				// The in-memory fallback keeps the old fast-start blob behavior.
				fastStart: this.target instanceof BufferTarget ? "in-memory" : false,
			}),
			target: this.target,
		});

		// Codec is deduced from the chunk metadata.
		this.videoSource = new EncodedVideoPacketSource("avc");
		this.output.addVideoTrack(this.videoSource, {
			frameRate: this.config.frameRate,
		});

		if (this.hasAudio) {
			this.audioSource = new EncodedAudioPacketSource(this.audioCodec);
			this.output.addAudioTrack(this.audioSource);
		}

		await this.output.start();
	}

	async addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): Promise<void> {
		if (!this.videoSource) {
			throw new Error("Muxer not initialized");
		}

		const packet = EncodedPacket.fromEncodedChunk(chunk);

		await this.videoSource.add(packet, meta);
	}

	async addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): Promise<void> {
		if (!this.audioSource) {
			throw new Error("Audio not configured for this muxer");
		}

		const packet = EncodedPacket.fromEncodedChunk(chunk);

		await this.audioSource.add(packet, meta);
	}

	async finalize(): Promise<Blob | null> {
		if (!this.output || !this.target) {
			throw new Error("Muxer not initialized");
		}

		await this.output.finalize();
		if (this.target instanceof StreamTarget) {
			if (!this.streamFinalized) throw new Error("Failed to publish export output");
			return null;
		}

		const buffer = this.target.buffer;

		if (!buffer) {
			throw new Error("Failed to finalize output");
		}

		return new Blob([buffer], { type: "video/mp4" });
	}

	async cancel(): Promise<void> {
		if (this.output && this.output.state !== "canceled" && this.output.state !== "finalized") {
			await this.output.cancel().catch(() => undefined);
		}
		if (this.streamOpen && this.outputPath && window.electronAPI?.closeExportStream) {
			await window.electronAPI.closeExportStream(this.outputPath, true).catch(() => undefined);
			this.streamOpen = false;
		}
	}
}
