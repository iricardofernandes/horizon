'use client'

import { SpanStatusCode, trace } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

let initialized = false

function tracer() {
  if (!initialized && typeof window !== 'undefined') {
    const configuredEndpoint = process.env.NEXT_PUBLIC_OTEL_EXPORTER_OTLP_ENDPOINT
    const endpoint =
      configuredEndpoint ??
      (window.location.hostname === 'localhost' ? 'http://localhost:4318' : '')
    if (!endpoint) {
      initialized = true
      return trace.getTracer('horizon.web')
    }
    const exporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    })
    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'web' }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    })
    provider.register()
    initialized = true
  }
  return trace.getTracer('horizon.web')
}

export async function tracedFetch(name: string, input: RequestInfo | URL, init: RequestInit = {}) {
  const span = tracer().startSpan(name)
  const context = span.spanContext()
  const headers = new Headers(init.headers)
  headers.set(
    'traceparent',
    `00-${context.traceId}-${context.spanId}-${context.traceFlags === 1 ? '01' : '00'}`,
  )
  try {
    const response = await fetch(input, { ...init, headers })
    span.setAttribute('http.response.status_code', response.status)
    if (!response.ok) span.setStatus({ code: SpanStatusCode.ERROR })
    return response
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error('Request failed'))
    span.setStatus({ code: SpanStatusCode.ERROR })
    throw error
  } finally {
    span.end()
  }
}
