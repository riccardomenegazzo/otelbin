import { request } from "http";
import { startCaptureServer } from "./processing-capture";

function postJson(url: string, path: string, body: unknown): Promise<{ statusCode: number; body: unknown }> {
	const payload = JSON.stringify(body);
	const parsed = new URL(url);

	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path,
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": Buffer.byteLength(payload)
				}
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf8");
					resolve({
						statusCode: response.statusCode ?? 0,
						body: raw ? JSON.parse(raw) : {}
					});
				});
			}
		);
		req.once("error", reject);
		req.end(payload);
	});
}

describe("startCaptureServer", () => {
	it("captures structured OTLP JSON by signal", async () => {
		const capture = await startCaptureServer({ port: 0 });
		try {
			const input = { resourceSpans: [{ scopeSpans: [] }] };
			const response = await postJson(capture.url, "/v1/traces", input);

			expect(response).toEqual({ statusCode: 200, body: {} });
			expect(capture.requests).toEqual([
				{
					signal: "traces",
					body: input
				}
			]);
		} finally {
			await capture.close();
		}
	});

	it("rejects unsupported OTLP paths", async () => {
		const capture = await startCaptureServer({ port: 0 });
		try {
			const response = await postJson(capture.url, "/v1/profiles", {});
			expect(response.statusCode).toBe(404);
			expect(capture.requests).toHaveLength(0);
		} finally {
			await capture.close();
		}
	});

	it("enforces the captured output byte limit", async () => {
		const capture = await startCaptureServer({ port: 0, maxOutputBytes: 16 });
		try {
			const response = await postJson(capture.url, "/v1/logs", {
				resourceLogs: [{ value: "this payload is intentionally too large" }]
			});

			expect(response.statusCode).toBe(413);
			expect(capture.requests).toHaveLength(0);
		} finally {
			await capture.close();
		}
	});

	it("enforces the request count limit", async () => {
		const capture = await startCaptureServer({ port: 0, maxRequests: 1 });
		try {
			expect((await postJson(capture.url, "/v1/metrics", { resourceMetrics: [] })).statusCode).toBe(200);
			expect((await postJson(capture.url, "/v1/metrics", { resourceMetrics: [] })).statusCode).toBe(413);
			expect(capture.requests).toHaveLength(1);
		} finally {
			await capture.close();
		}
	});
});
