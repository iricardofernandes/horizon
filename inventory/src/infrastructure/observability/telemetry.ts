import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { logs, metrics, NodeSDK } from '@opentelemetry/sdk-node'

const sdk =
  process.env.OTEL_SDK_DISABLED === 'true'
    ? null
    : new NodeSDK({
        resource: resourceFromAttributes({
          'service.name': process.env.OTEL_SERVICE_NAME ?? 'inventory',
        }),
        traceExporter: new OTLPTraceExporter(),
        metricReaders: [
          new metrics.PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter(),
            exportIntervalMillis: 10000,
          }),
        ],
        logRecordProcessors: [
          new logs.BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
        ],
        instrumentations: [
          getNodeAutoInstrumentations({
            '@opentelemetry/instrumentation-fs': { enabled: false },
          }),
        ],
      })

sdk?.start()

let shutdown: Promise<void> | undefined

export function stopTelemetry(): Promise<void> {
  shutdown ??= sdk?.shutdown() ?? Promise.resolve()
  return shutdown
}
