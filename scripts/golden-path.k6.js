import http from 'k6/http'
import { check } from 'k6'

const rates = [10, 20, 40, 80, 160]
const duration = __ENV.HORIZON_K6_STAGE_DURATION || '15s'

export const options = {
  discardResponseBodies: false,
  scenarios: Object.fromEntries(
    rates.map((rate, index) => [
      `rate_${rate}`,
      {
        executor: 'constant-arrival-rate',
        rate,
        timeUnit: '1s',
        duration,
        startTime: `${index * Number.parseInt(duration, 10)}s`,
        preAllocatedVUs: Math.max(10, rate),
        maxVUs: Math.max(50, rate * 4),
        tags: { load: String(rate) },
      },
    ]),
  ),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    ...Object.fromEntries(
      rates.map((rate) => [`http_req_duration{load:${rate}}`, ['p(95)<5000']]),
    ),
  },
}

export default function () {
  const response = http.post(`${__ENV.HORIZON_BENCHMARK_URL || 'http://127.0.0.1:3939'}/orders`)
  check(response, {
    'golden path completed': (result) => result.status === 201 && result.json('ok') === true,
  })
}
