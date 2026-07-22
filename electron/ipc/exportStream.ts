import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import type { IpcMain } from "electron";

type ActiveExport = {
	handle: FileHandle;
	tempPath: string;
};

/** Writes muxer chunks to a temp file and replaces the chosen output only on success. */
export class ExportStreamRegistry {
	private readonly exports = new Map<string, ActiveExport>();
	private nextId = 0;

	private createTempPath(filePath: string): string {
		this.nextId += 1;
		return `${filePath}.openscreen-${process.pid}-${this.nextId}.tmp`;
	}

	private async publish(tempPath: string, filePath: string): Promise<void> {
		try {
			await fs.rename(tempPath, filePath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EPERM") throw error;
			await fs.rm(filePath, { force: true });
			await fs.rename(tempPath, filePath);
		}
	}

	async open(filePath: string): Promise<void> {
		await this.discard(filePath);
		const tempPath = this.createTempPath(filePath);
		const handle = await fs.open(tempPath, "wx+");
		this.exports.set(filePath, { handle, tempPath });
	}

	async write(filePath: string, data: Uint8Array, position: number): Promise<void> {
		const active = this.exports.get(filePath);
		if (!active) throw new Error("No active export stream for this path");
		if (!Number.isSafeInteger(position) || position < 0) throw new Error("Invalid write position");

		let offset = 0;
		while (offset < data.byteLength) {
			const { bytesWritten } = await active.handle.write(
				data,
				offset,
				data.byteLength - offset,
				position + offset,
			);
			if (bytesWritten === 0) throw new Error("Export write made no progress");
			offset += bytesWritten;
		}
	}

	async finalize(filePath: string): Promise<void> {
		const active = this.exports.get(filePath);
		if (!active) throw new Error("No active export stream for this path");
		await active.handle.sync();
		await active.handle.close();
		await this.publish(active.tempPath, filePath);
		this.exports.delete(filePath);
	}

	async copyFrom(sourcePath: string, filePath: string): Promise<void> {
		await this.discard(filePath);
		const tempPath = this.createTempPath(filePath);
		try {
			await fs.copyFile(sourcePath, tempPath);
			await this.publish(tempPath, filePath);
		} catch (error) {
			await fs.rm(tempPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async discard(filePath: string): Promise<void> {
		const active = this.exports.get(filePath);
		if (!active) return;
		this.exports.delete(filePath);
		await active.handle.close().catch(() => undefined);
		await fs.rm(active.tempPath, { force: true }).catch(() => undefined);
	}
}

type ExportStreamResult = { success: boolean; error?: string };

export function registerExportStreamHandlers(
	ipcMain: IpcMain,
	registry: ExportStreamRegistry,
	approvePath: (filePath: string) => string | null,
	approveSource: (filePath: string) => Promise<string | null>,
): void {
	ipcMain.handle("open-export-stream", async (_, filePath: string): Promise<ExportStreamResult> => {
		try {
			const approved = approvePath(filePath);
			if (!approved) return { success: false, error: "Export path was not approved" };
			await registry.open(approved);
			return { success: true };
		} catch (error) {
			return { success: false, error: String(error) };
		}
	});

	ipcMain.handle(
		"write-export-chunk",
		async (
			_,
			filePath: string,
			data: Uint8Array,
			position: number,
		): Promise<ExportStreamResult> => {
			try {
				const approved = approvePath(filePath);
				if (!approved) return { success: false, error: "Export path was not approved" };
				await registry.write(approved, data, position);
				return { success: true };
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle(
		"copy-export-source",
		async (_, sourcePath: string, filePath: string): Promise<ExportStreamResult> => {
			try {
				const approvedTarget = approvePath(filePath);
				const approvedSource = await approveSource(sourcePath);
				if (!approvedTarget || !approvedSource) {
					return { success: false, error: "Export source or path was not approved" };
				}
				await registry.copyFrom(approvedSource, approvedTarget);
				return { success: true };
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);

	ipcMain.handle(
		"close-export-stream",
		async (_, filePath: string, discard = false): Promise<ExportStreamResult> => {
			try {
				const approved = approvePath(filePath);
				if (!approved) return { success: false, error: "Export path was not approved" };
				if (discard) await registry.discard(approved);
				else await registry.finalize(approved);
				return { success: true };
			} catch (error) {
				return { success: false, error: String(error) };
			}
		},
	);
}
