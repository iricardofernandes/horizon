# Golden-path load envelope

Measured on 2026-09-14. This is a local development envelope, not a production SLO or
capacity promise.

## Result

| Offered load | Completed | Failure rate | p95 end-to-end |
|---:|---:|---:|---:|
| 10 orders/s | 150 / 150 | 0% | 58.86 ms |
| 20 orders/s | 300 / 300 | 0% | 45.31 ms |
| 40 orders/s | 600 / 600 | 0% | 70.25 ms |
| 80 orders/s | 1,200 / 1,200 | 0% | 306.11 ms |
| 160 orders/s | 2,187 / ~2,400 | 0% for started requests | 2,636.68 ms |

The measured saturation point is **160 orders/s**. At that rate k6 reported 217 dropped
iterations, peak concurrency reached 363 VUs, and p95 rose from 306.11 ms at 80/s to
2.64 s. The highest sustained tested rate without a
dropped iteration was therefore **80 orders/s**.

Across the complete run, 4,437 orders finished, every started order completed the full
flow, and aggregate p95 was 2.45 s. The raw machine-readable k6 summary is
[`golden-path-summary.json`](golden-path-summary.json).

## What the request measures

Each HTTP request to the dedicated load target performs the same application-level path
as `make demo`:

1. Sales writes an order and its transactional outbox event.
2. RabbitMQ delivers `sales.order.placed` to Inventory's inbox.
3. Inventory reserves stock and emits its outcome through its outbox.
4. Sales confirms the order, emits `sales.order.confirmed` and requests invoicing.
5. Inventory confirms the reservation and writes the stock movement.
6. Webhooks consumes the broker copy of `sales.order.confirmed`, inserts its inbox/event
   and delivery rows, claims it through the cross-tenant worker, signs the exact payload
   and receives a 2xx from the HMAC-verifying callback before the load request succeeds.

The target uses the production module classes, PostgreSQL RLS connections, outbox/inbox
tables, RabbitMQ transport and Webhooks dispatcher. It only supplies the HTTP load surface;
it is not a replacement implementation of the flow.

## Method

- Command: `make benchmark-golden-path`
- Generator: Grafana k6 1.3.0 in Docker, using constant-arrival-rate scenarios
- Profile: 10, 20, 40, 80 and 160 orders/s, 15 seconds per rate, sequentially
- Platform: the repository's Compose PostgreSQL 17, RabbitMQ 4, OpenTelemetry Collector
  and Jaeger, all on the same host
- Runtime: Node.js 24.18.0; Docker 29.7.2; Docker Compose 5.5.0
- Host: AMD Ryzen 7 9800X3D, 8 cores / 16 threads, 30 GiB RAM
- Success condition: HTTP 201 only after the confirmed order, confirmed reservation,
  stock movement publication and valid signed callback
- Instrumentation: OTLP tracing remained enabled during the run

The command first runs `make demo`, which migrates and idempotently refreshes the fixture.
The load target then reuses database and broker connections. Its outbox drain uses a
1,000-event batch, AMQP prefetch is 100 and application pools are capped at 20 connections.

## Changes made from earlier runs

The initial 5–80 orders/s run saturated at 80/s: p95 was 901.26 ms and 13 iterations were
dropped. Inspection showed two measurement-path bottlenecks:

- every concurrent request queued a redundant four-relay drain cycle;
- callback delivery found its event by repeatedly scanning the JSON outbox payload.

The target now coalesces concurrent requests onto the in-flight relay cycle and consumes
the callback event from its RabbitMQ sink, which is also closer to the real Webhooks
architecture. At the same 80/s rate, p95 fell to 228.63 ms with all 1,200 iterations
started and completed. Extending the curve then exposed the new saturation point at
160/s. No production default was raised to hide the limit; 80/s is recorded as the safe
tested local envelope.

Phase 9 then replaced the target's direct callback shortcut with the real Webhooks inbox,
delivery persistence, bounded claim batch and HTTP dispatcher. Concurrent requests share
one in-flight dispatcher flush, just as relay pumping is coalesced. With the added durable
work, 80/s still completed without drops at 306.11 ms p95; 160/s remained the saturation
step, now at 2.64 s p95 with 217 dropped iterations.

## Reproduction and limits

```bash
make up
make benchmark-golden-path
```

Set `HORIZON_K6_STAGE_DURATION=30s` for a longer observation window. Duration must be an
integer number of seconds because scenario start times are derived from it.

The result is sensitive to host hardware, existing database size and other local
workloads. All components share one machine, and no external-network latency or
multi-instance contention is represented. The callback receiver is local, while event
ingestion, persistence, signing and dispatch all use the Phase 9 Webhooks implementation.
