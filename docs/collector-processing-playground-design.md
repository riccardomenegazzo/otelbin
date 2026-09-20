# Collector data-processing playground design

Status: design + backend configuration prototype  
Related upstream issue: dash0hq/otelbin#342

## Summary

OTelBin already answers an important question: “is this Collector configuration valid for this distribution/version?”

The next useful question is: “what does this configuration do to telemetry?”

The long-term feature should let a user provide OTLP test data, run selected parts of their existing Collector configuration with the exact Collector distribution/version already selected in OTelBin, and inspect the resulting OTLP data.

The first implementation should deliberately **not execute the user's full Collector configuration**. Collector configurations can contain arbitrary receivers, exporters, extensions and components that access the network, cloud metadata, files or host resources. Running an unmodified config inside the validation Lambda would turn a validation service into an execution service with a much larger security boundary.

The proposed MVP therefore tests **one processor instance at a time** inside a generated sandbox pipeline:

```
browser OTLP JSON
      |
      v
127.0.0.1 OTLP/HTTP receiver
      |
      v
selected user processor
      |
      v
127.0.0.1 OTLP/HTTP JSON exporter
      |
      v
Node capture server
      |
      v
browser output/diff
```

This immediately covers the highest-value interactive use case from #342: testing OTTL-based `transform` and `filter` processors. It also gives us a safe base for later processor-chain, tail-sampling and connector support.

## Goals

The MVP should:

1. Execute the processor from the user's current configuration using the exact Collector distribution/version selected in OTelBin.
2. Accept OTLP/HTTP JSON so users can read and edit fixtures directly.
3. Return the actual OTLP/HTTP JSON emitted by the Collector rather than parsing human-oriented debug logs.
4. Never execute user-configured receivers, exporters or extensions.
5. Never intentionally make outbound network requests while processing test data.
6. Bound CPU, memory, payload size, execution time and output size.
7. Keep normal configuration validation behavior unchanged.
8. Make unsupported processors explicit rather than silently changing semantics.

## Non-goals for the first PR

The first implementation should not:

- run the full user configuration;
- call user-configured exporters;
- start user-configured receivers;
- execute extensions;
- test connectors;
- claim support for processors whose behavior depends on external services;
- automatically run on every editor keystroke;
- persist test payloads or outputs;
- support arbitrarily large OTLP payloads.

Those can be added deliberately after the execution model is established.

## Why a generated pipeline is necessary

A full Collector configuration is executable infrastructure, not just data.

Examples of behavior we must not permit from an anonymous browser request include:

- exporters sending user-controlled telemetry to arbitrary Internet endpoints;
- receivers binding sockets or reading host/network state;
- file-based components reading or writing Lambda files;
- cloud-aware components reaching AWS/GCP/Azure metadata or APIs;
- extensions exposing additional endpoints;
- processors that enrich data through remote APIs;
- configs expanding environment values belonging to the service.

Validation is comparatively safe because `otelcol validate` performs a dry run. Data processing requires starting a Collector, so the security boundary changes materially.

The generated config eliminates most of that surface by copying only the selected processor definition into a pipeline whose boundaries are owned by OTelBin.

## MVP execution contract

### Request

The existing per-distribution/version Lambda can be reused instead of creating a second Lambda for every release.

A request can be discriminated by a top-level operation field:

```json
{
  "operation": "process",
  "config": "processors:\n  transform/redact:\n    ...",
  "env": {
    "SOME_USER_VALUE": "example"
  },
  "test": {
    "processor": "transform/redact",
    "signal": "traces",
    "input": {
      "resourceSpans": []
    }
  }
}
```

Normal validation remains backward compatible:

```json
{
  "config": "...",
  "env": {}
}
```

or may later become explicit:

```json
{
  "operation": "validate",
  "config": "...",
  "env": {}
}
```

### Response

A successful processing result should preserve exporter request boundaries instead of inventing a merge algorithm:

```json
{
  "message": "Telemetry processed",
  "signal": "traces",
  "processor": "transform/redact",
  "output": {
    "requests": [
      {
        "resourceSpans": []
      }
    ]
  },
  "runtime": {
    "distribution": "otelcol-contrib",
    "version": "v0.160.0",
    "durationMs": 184
  }
}
```

If a processor drops all telemetry, `requests` is an empty array. That is different from an execution error.

## Generated Collector configuration

For a selected processor `transform/redact` and signal `traces`, OTelBin generates a temporary config equivalent to:

```yaml
receivers:
  otlp/otelbin_test:
    protocols:
      http:
        endpoint: 127.0.0.1:14318

processors:
  transform/redact:
    # exact configuration copied from the user's processors map

exporters:
  otlphttp/otelbin_capture:
    endpoint: http://127.0.0.1:14319
    encoding: json
    compression: none
    retry_on_failure:
      enabled: false
    sending_queue:
      enabled: false

service:
  pipelines:
    traces/otelbin_test:
      receivers: [otlp/otelbin_test]
      processors: [transform/redact]
      exporters: [otlphttp/otelbin_capture]
```

Why these boundaries:

- both endpoints bind only to loopback;
- OTLP HTTP exists in the Collector distributions OTelBin already targets;
- the exporter supports `encoding: json`, so the Node handler can capture structured OTLP without decoding protobuf;
- retries and queues are disabled so a failed local capture does not extend request lifetime;
- compression is disabled to keep capture logic simple and deterministic.

The current validation Lambda already contains one Collector binary for a specific distribution/version, making it a natural execution environment.

## Processor allowlist

The MVP must use an explicit allowlist.

The first PR should support only:

- `transform`
- `filter`

This is intentionally narrower than the eventual feature. Both map directly to the primary OTTL use case from #342, and keeping the first allowlist to two processors makes the security review concrete.

Additional processors should be added only in follow-up PRs after their runtime behavior is reviewed individually.

A processor is identified by component type, not full component ID. Distribution/version support is then checked with the generated sandbox config itself via `otelcol validate`; do not parse `otelcol components` as a stable API because its output format is explicitly not stable upstream.

Examples:

- `transform` -> type `transform`
- `transform/redact-pii` -> type `transform`

Unknown or unsupported processors return a structured error.

This is intentionally conservative. Adding a processor to the allowlist is a security and runtime-compatibility decision, not just a UI decision.

## Tail sampling

Tail sampling is a major use case from #342, but it should be a second milestone.

The current tail-sampling processor defaults `decision_wait` to 30 seconds. The existing validation Lambda timeout is 15 seconds. Pretending this is supported by silently reducing `decision_wait` would invalidate the test because OTelBin would no longer be running the user's actual configuration.

A later tail-sampling slice should define:

- a separate maximum execution window;
- behavior when `decision_wait` exceeds that window;
- multi-request trace fixtures;
- explicit wait/flush semantics;
- memory bounds for `num_traces`;
- whether a dedicated processing Lambda configuration is justified.

The correct first behavior for an unsupported temporal processor is a clear explanation, not config mutation.

## Connector support

Connectors are a later topology-level feature.

Testing a connector such as `spanmetrics` requires more than putting one component between a receiver and exporter because a connector is an exporter in one pipeline and a receiver in another.

A future design can build a sandbox topology containing only:

- OTelBin-owned ingress receivers;
- selected user processors;
- selected user connectors;
- OTelBin-owned capture exporters.

No user receiver/exporter/extension should be copied into that topology.

The single-processor MVP intentionally gives us the capture/input infrastructure needed for this without solving topology rewriting in the first PR.

## Lambda lifecycle

For `operation=process`:

1. Parse and validate the request.
2. Parse the user's YAML using the existing safe JSON-schema mode.
3. Verify the selected processor exists.
4. Verify the processor type is allowlisted.
5. Allocate invocation-specific loopback ports for ingress and capture.
6. Generate a temporary sandbox Collector config using those ports.
7. Run `otelcol validate --config=<sandbox-config>` against the generated config before execution.
8. If validation reports that the selected processor does not exist in this distribution/version, return a structured capability error rather than attempting startup.
9. Start a Node HTTP capture server bound to the allocated `127.0.0.1` capture port.
10. Spawn the Collector directly with the generated config.
11. Wait until the local OTLP receiver is accepting requests.
12. POST the user OTLP JSON to the correct local path:
   - `/v1/traces`
   - `/v1/metrics`
   - `/v1/logs`
13. Wait for capture output or a short quiescence deadline.
14. Gracefully terminate the Collector.
15. Close the capture server.
16. Return the captured OTLP JSON.

Cleanup must be in `finally` so warm Lambda invocations never inherit a Collector process or open local server from a previous request.

## Readiness detection

Do not use a fixed sleep.

Preferred order:

1. Start the Collector.
2. Poll its local OTLP HTTP receiver using TCP connect or a bounded HTTP attempt.
3. Abort immediately if the child exits.
4. Fail with an internal execution error if readiness is not reached within the startup budget.

This keeps cold-start variance from creating flaky tests.

## OTLP input

The browser should initially use OTLP/HTTP JSON request envelopes because they are readable and map directly to Collector endpoints.

Examples:

### Traces

```json
{
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          {
            "key": "service.name",
            "value": { "stringValue": "checkout" }
          }
        ]
      },
      "scopeSpans": []
    }
  ]
}
```

### Metrics

```json
{
  "resourceMetrics": []
}
```

### Logs

```json
{
  "resourceLogs": []
}
```

The UI can ship small editable fixtures for each signal, but fixture design is independent from the execution backend.

## Input validation and bounds

Before starting a Collector:

- request body: maximum 256 KiB;
- config: maximum 128 KiB;
- OTLP input: maximum 128 KiB;
- env entries: maximum 64;
- env key length: maximum 128 bytes;
- env value length: maximum 4 KiB;
- one selected processor in the MVP;
- signals: `traces | metrics | logs`;
- captured output: maximum 512 KiB total;
- maximum captured OTLP requests: 32;
- startup deadline: approximately 3 seconds;
- processing deadline: approximately 5 seconds for MVP processors;
- hard Lambda timeout remains a final safety net, not control flow.

Exact numbers should be tuned with deployment measurements, but the limits should exist before the endpoint is exposed.

## Environment handling

User-provided `env` values are needed for legitimate Collector config interpolation.

The spawned Collector must receive a deliberately constructed environment rather than all Lambda environment variables.

Do **not** pass through service secrets such as the Dash0 authorization token.

The processing environment should contain only:

- a minimal OS/runtime allowlist required for process execution;
- explicit user-provided env values after validation;
- OTelBin-owned values needed by the generated sandbox config.

The compiler must also inspect string values inside the selected processor configuration for Collector confmap provider references. For the MVP, only `${env:...}` references are allowed. References such as `${file:...}`, `${http:...}`, `${https:...}` or other provider schemes must be rejected before starting the Collector.

This matters because Collector distributions can include file and remote config providers. Sanitizing the process environment alone does not prevent a copied processor value from asking the Collector resolver to read local files or fetch remote configuration.

This is stricter than the existing validation path and is important because processing starts components rather than only dry-running them.

## Network boundary

The generated pipeline uses only `127.0.0.1`.

The MVP allowlist must exclude components known to perform network access. That is the first enforcement layer.

If AWS networking is later moved into a VPC or another runtime is used, an egress-deny layer would be a useful second defense, but the correctness of the feature should not depend solely on infrastructure-level egress filtering.

## File-system boundary

Use one invocation-specific temporary directory, for example:

```
/tmp/otelbin-processing/<request-id>/
```

Store only:

- generated Collector config;
- optional diagnostic output bounded in size.

Delete it in `finally`.

Never resolve config paths supplied by the user.

## Process control

The child Collector process should:

- be spawned directly where practical rather than through a shell;
- have stdout/stderr captured with strict byte limits;
- inherit only the sanitized environment;
- receive SIGTERM during normal cleanup;
- receive SIGKILL after a short grace period;
- never survive handler completion.

A process-tree cleanup helper is preferable if any distribution wraps the real Collector binary.

## Error model

Errors should distinguish user configuration from execution infrastructure.

Suggested response categories:

- `invalid_request`
- `processor_not_found`
- `processor_not_supported`
- `processor_unavailable_in_distribution`
- `unsupported_confmap_provider`
- `collector_start_failed`
- `collector_not_ready`
- `input_rejected`
- `processing_timeout`
- `output_limit_exceeded`
- `collector_exited`

Do not return unbounded raw stdout/stderr to the browser. Include a bounded diagnostic field and keep full diagnostics in CloudWatch.

## API/infrastructure shape

Avoid creating one new Lambda per distribution/version.

OTelBin already has one Docker-image Lambda per supported release. The same Lambda image contains the exact Collector binary needed for processing.

Avoid adding a second API Gateway resource per release as the first implementation too: the validation stack already has a known resource-count scaling problem.

The lowest-infrastructure-cost path is therefore to reuse the existing POST integration and discriminate the payload by `operation`.

The Next.js app can still expose a separate first-party route such as:

```
POST /processing?distro=otelcol-contrib&version=v0.160.0
```

That route forwards an `operation: "process"` payload to the existing versioned backend endpoint.

This gives the browser a clean API without multiplying CloudFormation resources.

## Frontend UX

The first UI should be explicit and user-triggered, not automatic.

Suggested interaction:

1. User selects a supported distro/version as today.
2. OTelBin identifies processor instances from the current YAML.
3. A “Test processor” action opens a side panel.
4. User selects:
   - processor;
   - signal;
   - editable OTLP JSON fixture.
5. “Run” sends one processing request.
6. UI shows:
   - input JSON;
   - output JSON;
   - structured diff;
   - execution time;
   - clear “dropped all telemetry” state.

For OTTL processors, this turns OTelBin into an interactive transform/filter workbench.

## Observability

Processing should emit internal metrics/log fields such as:

- distribution;
- Collector version;
- processor type, **not instance name if it could contain sensitive data**;
- signal;
- request/input/output sizes;
- startup duration;
- processing duration;
- outcome category;
- timeout/output-limit counts.

Do not log test telemetry payloads or environment values.

## Rate limiting

Processing is more expensive than validation and must have a separate limit.

The existing Next.js rate-limiting path can use a lower processing quota, for example a small number of runs per minute per client.

The backend still needs hard resource/time/payload bounds because rate limiting is not a sandbox.

## Testing strategy

### Pure unit tests

Test the sandbox config compiler:

- copies only the selected processor;
- preserves named processor IDs;
- rejects missing processors;
- rejects unsupported processor types;
- emits loopback-only receiver/exporter endpoints using runtime-supplied ports;
- does not copy receivers/exporters/extensions/service settings from the user config;
- preserves processor config values exactly;
- handles env interpolation strings without evaluating them in Node.

### Handler tests

Mock child process + capture server behavior:

- startup success;
- startup failure;
- processor drops all data;
- capture receives one request;
- capture receives multiple requests;
- input rejected by Collector;
- processing timeout;
- output limit;
- child cleanup on every error branch.

### Container integration tests

Using the actual validation image:

- transform adds/removes an attribute;
- filter drops a matching span/log/metric;
- unsupported processor returns the expected category;
- no network-capable user boundary component is present in the generated config;
- repeated invocations do not leak ports/processes.

### Deployed integration tests

Run against at least the latest:

- otelcol-core where the selected processor exists;
- otelcol-contrib;
- ADOT;
- Splunk distribution.

Capability varies by distro. Unsupported component errors should remain distribution/version-specific and understandable.

## Rollout plan

### Phase 1 — single safe processor

Backend compiler + execution harness for a small explicit allowlist.

Primary target: `transform` and `filter`.

### Phase 2 — processor chains

Allow selection of a pipeline and compile only its processor chain between OTelBin-owned ingress/egress boundaries.

User receivers/exporters are still excluded.

### Phase 3 — temporal processors

Tail sampling and other buffered/stateful processors with an explicit execution-window contract.

### Phase 4 — connectors

Generate a sandbox multi-pipeline graph around selected connectors such as `spanmetrics`.

### Phase 5 — regression comparison

Run the same fixture/config slice against two selected Collector versions and show the output diff.

This is where OTelBin's existing per-version validation infrastructure becomes especially valuable.

## Open questions for maintainers

1. Is reusing the current versioned validation Lambda with an `operation` discriminator acceptable, or would the team prefer processing to be isolated in a separate service despite the additional infrastructure?
2. Should the first slice be limited to `transform` and `filter`, or is there another processor the team considers essential for the MVP?
3. Is OTLP/HTTP JSON the preferred fixture format for the browser?
4. Should processing remain available only when server-side validation is configured, or should it have a separate feature flag?
5. What request/runtime limits fit the project's expected public-service cost envelope?
6. Would the maintainers prefer the first PR to contain only the backend execution harness, with UI following separately?

## Recommended first PR boundary

The first upstream PR should be intentionally smaller than the full feature:

- request/response types for `operation=process`;
- pure sandbox config compiler;
- explicit processor allowlist;
- local OTLP capture server;
- process lifecycle with hard bounds;
- handler path for one processor;
- unit + container integration tests;
- no UI beyond what is required to exercise the endpoint.

A second PR can add the processor-testing panel once the execution contract has been reviewed in isolation.

This division keeps the security-sensitive backend review focused and makes rollback straightforward.
