import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");

async function exportFromLoadedVideo(format: "gif" | "mp4"): Promise<Buffer> {
	const outputPath = path.join(os.tmpdir(), `test-${format}-export-${Date.now()}.${format}`);
	const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-export-e2e-"));
	let testVideoInRecordings = "";

	const app = await electron.launch({
		args: [
			MAIN_JS,
			// Required in CI sandbox environments (GitHub Actions, Docker, etc.)
			"--no-sandbox",
			// Force software WebGL in headless CI to avoid GPU framebuffer errors.
			"--enable-unsafe-swiftshader",
			`--user-data-dir=${testUserDataDir}`,
		],
		env: {
			...process.env,
			ELECTRON_USER_DATA_DIR: testUserDataDir,
			// Set HEADLESS=false to show windows while debugging.
			HEADLESS: process.env["HEADLESS"] ?? "true",
		},
	});
	const electronProcess = app.process();

	app.process().stdout?.on("data", (d) => process.stdout.write(`[electron] ${d}`));
	app.process().stderr?.on("data", (d) => process.stderr.write(`[electron] ${d}`));

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		await app.evaluate(({ dialog }, targetPath: string) => {
			dialog.showSaveDialog = async () => ({
				canceled: false,
				filePath: targetPath,
			});
		}, outputPath);

		const userDataDir = await app.evaluate(({ app: electronApp }) => {
			return electronApp.getPath("userData");
		});
		const recordingsDir = path.join(userDataDir, "recordings");
		testVideoInRecordings = path.join(recordingsDir, "test-sample.webm");
		fs.mkdirSync(recordingsDir, { recursive: true });
		fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

		await hudWindow.evaluate(
			(videoPath: string) => window.electronAPI.setCurrentVideoPath(videoPath),
			testVideoInRecordings,
		);
		try {
			await hudWindow.evaluate(() => window.electronAPI.switchToEditor());
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/closed|destroyed|target page|target closed/i.test(error.message)
			) {
				throw error;
			}
		}

		const editorWindow = await app.waitForEvent("window", {
			predicate: (w) => w.url().includes("windowType=editor"),
			timeout: 15_000,
		});

		// WebCodecs may not be registered in the renderer on first load.
		await editorWindow.reload();
		await editorWindow.waitForLoadState("domcontentloaded");
		await expect(editorWindow.getByText("Loading video...")).not.toBeVisible({
			timeout: 15_000,
		});

		await editorWindow.getByTestId("testId-export-panel-button").click();
		await editorWindow.getByTestId(`testId-${format}-format-button`).click();
		await editorWindow.getByTestId("testId-export-button").click();

		await expect
			.poll(() => fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024, {
				timeout: 90_000,
			})
			.toBe(true);

		expect(fs.existsSync(outputPath), `${format.toUpperCase()} not found at ${outputPath}`).toBe(
			true,
		);
		const stats = fs.statSync(outputPath);
		expect(stats.size).toBeGreaterThan(1024);
		return fs.readFileSync(outputPath);
	} finally {
		const exitPromise =
			electronProcess.exitCode === null ? once(electronProcess, "exit") : Promise.resolve();
		await app
			.evaluate(({ app: electronApp }) => {
				electronApp.exit(0);
			})
			.catch(() => {
				// The process may already be gone after export completes.
			});
		if (electronProcess.exitCode === null) {
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/PID", String(electronProcess.pid), "/T", "/F"], {
					stdio: "ignore",
				});
			} else {
				electronProcess.kill("SIGKILL");
			}
		}
		await exitPromise.catch(() => {
			// Cleanup below can still remove the isolated test data.
		});
		if (fs.existsSync(outputPath)) {
			fs.unlinkSync(outputPath);
		}
		if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
			fs.unlinkSync(testVideoInRecordings);
		}
		fs.rmSync(testUserDataDir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	}
}

test("exports an MP4 from a loaded video", async () => {
	const exported = await exportFromLoadedVideo("mp4");

	expect(exported.subarray(4, 8).toString("ascii")).toBe("ftyp");
});

test("exports a GIF from a loaded video", async () => {
	const exported = await exportFromLoadedVideo("gif");

	expect(exported.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a/);
});
