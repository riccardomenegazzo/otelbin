import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";

export type CaptureSignal = "traces" | "metrics" | "logs";

export interface CapturedOtlpRequest {
	signal: CaptureSignal;
	body: unknown;
}

export interface CaptureServerOptions {
	host?: string;
	port?: number;
	maxRequests?: number;
	maxOutputBytes?: number;
}

export interface CaptureServer {
	url: string;
	requests: CapturedOtlpRequest[];
	close(): Promise<void>;
}

const defaultHost = "127.0.0.1";
const defaultPort = 14319;
const defaultMaxRequests = 32;
const defaultMaxOutputBytes = 512 * 1024;

function signalFromPath(pathname: string | undefined): CaptureSignal | undefined {
	switch (pathname) {
		case "/v1/traces":
			return "traces";
		case "/v1/metrics":
			return "metrics";
		case "/v1/logs":
			return "logs";
		default:
			return undefined;
	}
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<{ body: unknown; bytes: number }> {
	const chunks: Buffer[] = [];
	let bytes = 0;

	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > maxBytes) {
			throw new Error("capture_output_limit_exceeded");
		}
		chunks.push(buffer);
	}

	const raw = Buffer.concat(chunks).toString("utf8");
	return {
		body: raw.length ? JSON.parse(raw) : {},
		bytes
	};
}

export async function startCaptureServer(options: CaptureServerOptions = {}): Promise<CaptureServer> {
	const host = options.host ?? defaultHost;
	const port = options.port ?? defaultPort;
	const maxRequests = options.maxRequests ?? defaultMaxRequests;
	const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;

	const requests: CapturedOtlpRequest[] = [];
	let capturedBytes = 0;

	const server: Server = createServer(async (request, response) => {
		try {
			if (request.method !== "POST") {
				writeJson(response, 405, { error: "method_not_allowed" });
				return;
			}

			const pathname = request.url ? new URL(request.url, "http://localhost").pathname : undefined;
			const signal = signalFromPath(pathname);
			if (!signal) {
				writeJson(response, 404, { error: "unsupported_otlp_path" });
				return;
			}

			if (requests.length >= maxRequests) {
				writeJson(response, 413, { error: "capture_request_limit_exceeded" });
				return;
			}

			const remainingBytes = maxOutputBytes - capturedBytes;
			if (remainingBytes <= 0) {
				writeJson(response, 413, { error: "capture_output_limit_exceeded" });
				return;
			}

			const captured = await readJsonBody(request, remainingBytes);
			capturedBytes += captured.bytes;
			requests.push({
				signal,
				body: captured.body
			});

			// OTLP/HTTP Export*ServiceResponse messages are empty for a complete success.
			writeJson(response, 200, {});
		} catch (error) {
			if (String(error).includes("capture_output_limit_exceeded")) {
				writeJson(response, 413, { error: "capture_output_limit_exceeded" });
				return;
			}
			writeJson(response, 400, { error: "invalid_otlp_json" });
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (address == null || typeof address === "string") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("Unable to determine capture server address");
	}

	return {
		url: `http://${host}:${address.port}`,
		requests,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			})
	};
}
