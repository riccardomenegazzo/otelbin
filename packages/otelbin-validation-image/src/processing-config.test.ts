const yaml = require("js-yaml");
import {
	buildSingleProcessorTestConfig,
	componentType,
	ProcessingConfigError,
	supportedProcessingProcessorTypes
} from "./processing-config";

const defaultEndpoints = { ingressPort: 14318, capturePort: 14319 };

describe("componentType", () => {
	it("returns the component type for named instances", () => {
		expect(componentType("transform/redact-pii")).toBe("transform");
		expect(componentType("filter")).toBe("filter");
	});
});

describe("buildSingleProcessorTestConfig", () => {
	it("generates a loopback-only pipeline around the selected processor", () => {
		const result = buildSingleProcessorTestConfig(
			`
receivers:
  otlp:
    protocols:
      grpc:
exporters:
  otlphttp/customer:
    endpoint: https://example.invalid
processors:
  transform/redact:
    error_mode: ignore
    trace_statements:
      - context: span
        statements:
          - set(attributes["sanitized"], true)
extensions:
  health_check:
service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [transform/redact]
      exporters: [otlphttp/customer]
`,
			"transform/redact",
			"traces",
			defaultEndpoints
		);

		const config = yaml.load(result) as any;

		expect(config.receivers).toEqual({
			"otlp/otelbin_test": {
				protocols: {
					http: {
						endpoint: "127.0.0.1:14318"
					}
				}
			}
		});
		expect(config.exporters).toEqual({
			"otlphttp/otelbin_capture": {
				endpoint: "http://127.0.0.1:14319",
				encoding: "json",
				compression: "none",
				retry_on_failure: { enabled: false },
				sending_queue: { enabled: false }
			}
		});
		expect(config.processors).toEqual({
			"transform/redact": {
				error_mode: "ignore",
				trace_statements: [
					{
						context: "span",
						statements: ['set(attributes["sanitized"], true)']
					}
				]
			}
		});
		expect(config.extensions).toBeUndefined();
		expect(config.service).toEqual({
			pipelines: {
				"traces/otelbin_test": {
					receivers: ["otlp/otelbin_test"],
					processors: ["transform/redact"],
					exporters: ["otlphttp/otelbin_capture"]
				}
			}
		});
	});

	it("preserves env provider references without resolving them in Node", () => {
		const input = [
			"processors:",
			"  transform/example:",
			"    error_mode: ignore",
			"    trace_statements:",
			"      - context: span",
			"        statements:",
			'          - set(attributes["environment"], "${env:DEPLOYMENT_ENVIRONMENT}")'
		].join("\n");

		const result = buildSingleProcessorTestConfig(input, "transform/example", "traces", defaultEndpoints);

		expect(result).toContain("${env:DEPLOYMENT_ENVIRONMENT}");
	});

	it("rejects a missing processor", () => {
		expect(() => buildSingleProcessorTestConfig("processors: {}", "transform/missing", "traces", defaultEndpoints)).toThrow(
			new ProcessingConfigError("processor_not_found", 'Processor "transform/missing" is not configured')
		);
	});

	it("keeps the initial processor allowlist intentionally small", () => {
		expect([...supportedProcessingProcessorTypes].sort()).toEqual(["filter", "transform"]);
		expect(supportedProcessingProcessorTypes.has("tail_sampling")).toBe(false);

		expect(() =>
			buildSingleProcessorTestConfig(
				`
processors:
  tail_sampling:
    decision_wait: 30s
`,
				"tail_sampling",
				"traces",
				defaultEndpoints
			)
		).toThrow(
			new ProcessingConfigError(
				"processor_not_supported",
				'Processor type "tail_sampling" is not supported by the processing playground'
			)
		);
	});

	it("rejects a non-mapping Collector configuration", () => {
		expect(() => buildSingleProcessorTestConfig("- not\n- a\n- mapping", "transform/example", "traces", defaultEndpoints)).toThrow(
			new ProcessingConfigError("invalid_config", "Collector configuration must be a YAML mapping")
		);
	});
	it.each([
		[{ ingressPort: 0, capturePort: 14319 }, "ingressPort", 0],
		[{ ingressPort: 14318, capturePort: 65536 }, "capturePort", 65536],
		[{ ingressPort: 1.5, capturePort: 14319 }, "ingressPort", 1.5]
	])("rejects invalid runtime endpoints %p", (endpoints, name, port) => {
		expect(() =>
			buildSingleProcessorTestConfig("processors:\n  transform/example: {}", "transform/example", "traces", endpoints)
		).toThrow(new ProcessingConfigError("invalid_config", `Invalid ${name}: ${port}`));
	});
});


describe("processing sandbox provider restrictions", () => {
	it("allows env provider references because the runtime uses a sanitized environment", () => {
		const input = [
			"processors:",
			"  transform/example:",
			"    error_mode: ignore",
			"    trace_statements:",
			"      - context: span",
			"        statements:",
			'          - set(attributes["environment"], "${env:DEPLOYMENT_ENVIRONMENT}")'
		].join("\n");

		expect(() =>
			buildSingleProcessorTestConfig(input, "transform/example", "traces", defaultEndpoints)
		).not.toThrow();
	});

	it.each(["file", "http", "https", "yaml"])("rejects the %s config provider inside processor config", (scheme) => {
		const providerExpression = "${" + scheme + ":example}";
		const input = [
			"processors:",
			"  transform/example:",
			"    error_mode: ignore",
			"    trace_statements:",
			"      - context: span",
			"        statements:",
			'          - set(attributes["value"], "' + providerExpression + '")'
		].join("\n");

		expect(() =>
			buildSingleProcessorTestConfig(input, "transform/example", "traces", defaultEndpoints)
		).toThrow(
			new ProcessingConfigError(
				"unsupported_confmap_provider",
				`Config provider "${scheme}" is not allowed in the processing playground`
			)
		);
	});

	it("uses invocation-specific loopback ports supplied by the runtime", () => {
		const result = buildSingleProcessorTestConfig(
			`
processors:
  filter/example:
    error_mode: ignore
    traces:
      span:
        - attributes["drop"] == true
`,
			"filter/example",
			"traces",
			{ ingressPort: 21001, capturePort: 21002 }
		);
		const config = yaml.load(result) as any;

		expect(config.receivers["otlp/otelbin_test"].protocols.http.endpoint).toBe("127.0.0.1:21001");
		expect(config.exporters["otlphttp/otelbin_capture"].endpoint).toBe("http://127.0.0.1:21002");
	});
});
