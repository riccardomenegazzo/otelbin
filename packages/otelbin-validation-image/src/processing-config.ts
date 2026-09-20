const yaml = require("js-yaml");

export type TelemetrySignal = "traces" | "metrics" | "logs";

export const supportedProcessingProcessorTypes = new Set(["filter", "transform"]);

const testReceiverId = "otlp/otelbin_test";
const captureExporterId = "otlphttp/otelbin_capture";
interface CollectorConfig {
	processors?: Record<string, unknown>;
	[key: string]: unknown;
}

export class ProcessingConfigError extends Error {
	constructor(
		readonly code:
			| "processor_not_found"
			| "processor_not_supported"
			| "invalid_config"
			| "unsupported_confmap_provider",
		message: string
	) {
		super(message);
		this.name = "ProcessingConfigError";
	}
}

export function componentType(componentId: string): string {
	return componentId.split("/", 1)[0] ?? componentId;
}

export interface ProcessingEndpoints {
	ingressPort: number;
	capturePort: number;
}

function assertSafeProviderReferences(value: unknown): void {
	if (typeof value === "string") {
		const providerPattern = /\$\{([a-zA-Z][a-zA-Z0-9+.-]*):/g;
		for (const match of value.matchAll(providerPattern)) {
			const scheme = match[1]?.toLowerCase();
			if (scheme !== "env") {
				throw new ProcessingConfigError(
					"unsupported_confmap_provider",
					`Config provider "${scheme}" is not allowed in the processing playground`
				);
			}
		}
		return;
	}

	if (Array.isArray(value)) {
		value.forEach(assertSafeProviderReferences);
		return;
	}

	if (value != null && typeof value === "object") {
		Object.values(value as Record<string, unknown>).forEach(assertSafeProviderReferences);
	}
}

export function buildSingleProcessorTestConfig(
	userConfigYaml: string,
	processorId: string,
	signal: TelemetrySignal,
	endpoints: ProcessingEndpoints
): string {
	for (const [name, port] of Object.entries(endpoints)) {
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new ProcessingConfigError("invalid_config", `Invalid ${name}: ${port}`);
		}
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(userConfigYaml, { schema: yaml.JSON_SCHEMA });
	} catch (error) {
		throw new ProcessingConfigError("invalid_config", `Unable to parse Collector configuration: ${String(error)}`);
	}

	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ProcessingConfigError("invalid_config", "Collector configuration must be a YAML mapping");
	}

	const userConfig = parsed as CollectorConfig;
	const processors = userConfig.processors;
	if (processors == null || typeof processors !== "object" || Array.isArray(processors)) {
		throw new ProcessingConfigError("processor_not_found", `Processor "${processorId}" is not configured`);
	}

	if (!Object.prototype.hasOwnProperty.call(processors, processorId)) {
		throw new ProcessingConfigError("processor_not_found", `Processor "${processorId}" is not configured`);
	}

	const processorType = componentType(processorId);
	if (!supportedProcessingProcessorTypes.has(processorType)) {
		throw new ProcessingConfigError(
			"processor_not_supported",
			`Processor type "${processorType}" is not supported by the processing playground`
		);
	}

	assertSafeProviderReferences(processors[processorId]);

	const generatedConfig = {
		receivers: {
			[testReceiverId]: {
				protocols: {
					http: {
						endpoint: `127.0.0.1:${endpoints.ingressPort}`
					}
				}
			}
		},
		processors: {
			[processorId]: processors[processorId]
		},
		exporters: {
			[captureExporterId]: {
				endpoint: `http://127.0.0.1:${endpoints.capturePort}`,
				encoding: "json",
				compression: "none",
				retry_on_failure: {
					enabled: false
				},
				sending_queue: {
					enabled: false
				}
			}
		},
		service: {
			pipelines: {
				[`${signal}/otelbin_test`]: {
					receivers: [testReceiverId],
					processors: [processorId],
					exporters: [captureExporterId]
				}
			}
		}
	};

	return yaml.dump(generatedConfig, {
		noRefs: true,
		lineWidth: 120,
		sortKeys: false
	});
}
