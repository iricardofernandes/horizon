import type { ProbeRun, Step } from './probe.js'

export interface ProbeMetricsState {
  runs: { success: number; failure: number }
  stepSeconds: Partial<Record<Step, number>>
  lastSuccessSeconds: number | null
}

export const EMPTY_METRICS: ProbeMetricsState = {
  runs: { success: 0, failure: 0 },
  stepSeconds: {},
  lastSuccessSeconds: null,
}

/** The state after one more run; the previous state is left as it was. */
export function recordRun(
  state: ProbeMetricsState,
  run: ProbeRun,
  finishedAtMs: number,
): ProbeMetricsState {
  const stepSeconds = { ...state.stepSeconds }
  for (const step of run.steps) stepSeconds[step.step] = step.seconds
  return {
    runs: {
      success: state.runs.success + (run.ok ? 1 : 0),
      failure: state.runs.failure + (run.ok ? 0 : 1),
    },
    stepSeconds,
    lastSuccessSeconds: run.ok ? finishedAtMs / 1000 : state.lastSuccessSeconds,
  }
}

/** The Prometheus text exposition format (version 0.0.4). */
export function renderMetrics(state: ProbeMetricsState): string {
  const lines = [
    '# HELP horizon_probe_runs_total Runs of the synthetic probe of the critical path, by outcome.',
    '# TYPE horizon_probe_runs_total counter',
    `horizon_probe_runs_total{outcome="success"} ${state.runs.success}`,
    `horizon_probe_runs_total{outcome="failure"} ${state.runs.failure}`,
    '# HELP horizon_probe_step_seconds How long each step took in the latest run that reached it.',
    '# TYPE horizon_probe_step_seconds gauge',
    ...Object.entries(state.stepSeconds).map(
      ([step, seconds]) => `horizon_probe_step_seconds{step="${step}"} ${seconds}`,
    ),
  ]
  if (state.lastSuccessSeconds !== null)
    lines.push(
      '# HELP horizon_probe_last_success_timestamp_seconds When the latest successful run finished.',
      '# TYPE horizon_probe_last_success_timestamp_seconds gauge',
      `horizon_probe_last_success_timestamp_seconds ${state.lastSuccessSeconds}`,
    )
  return `${lines.join('\n')}\n`
}
