# Phase 41 verification record

Status: **delivered locally on 2026-09-22**.

Phase 41 implements temporal tax rules, deterministic exact calculations, immutable
calculation locks and source-backed explanations. The workspace owner approved the
documented narrow fiscal scenario on 2026-09-22. This is project acceptance for a local
simulation fixture, not government homologation or permission for production issuance.

## Official artifact and approval

The official Receita Federal/SERPRO download resolved to `calculadora.zip`, 346,174,581
bytes, SHA-256
`f451c3902621f02f3a63da29cd63d1e8e0f0456cce44425f1e22c89c079cb68e`.
ZIP integrity passed. The official installer distributes a root filesystem for
`docker import`, not an OCI image, so the archive and inner `calculadora.tar.gz` are
pinned separately in the [source manifest](fiscal-phase41-source-manifest.json).

The archive contains database `V0057` dated 2026-09-03 while the landing page displayed
`V0042 - 1.3.0-af611293 - APR`; the online endpoint also reported database `V0057` at
retrieval. This discrepancy was disclosed and explicitly accepted by `workspace-owner`
for fixture `rtc-v0057-model55-normal-sale-sp-2026-01` only.

The archive is retained at its gitignored content-addressed path. Migration `0018` adds
an append-only, tenant-isolated `fiscal_source_artifacts` binding with digest, byte size,
storage URI, verification time and retaining actor. The rollout verifies the file's hash
before import. Package `2dd2ffbe-2571-5c1d-a7a0-73162538f1da` has the same digest and was
approved by `workspace-owner` at `2026-09-22T13:30:00Z`.

## Approved scenario and golden result

Only `rtc-v0057-model55-normal-sale` is enabled: NF-e model 55, simulation,
normal-regime intrastate SP sale, NCM `09012100`, interval
`[2026-01-01, 2027-01-01)`. Every other scenario defaults to unsupported.

The reviewed mapping is CBS `9/1000`, IBS_UF `1/1000` and IBS_MUN `0/1`, using exact
integer/rational arithmetic and half-away-from-zero component rounding. For BRL 100.00,
the approved result is 90, 10 and 0 minor units respectively:

| Evidence | Digest |
|---|---|
| Input | `c68492b3f0251036a631fa9c317bc1fd9e8b0427146b264c7661f10798cd5234` |
| Rules | `25ade44c1a5fe2b14c3444802dc7903e4691d769390bbc20dab17cd30e2d1c99` |
| Result | `256201c9c98a25c6aee00622da86b01e1a18eb880a5fe583ca1f68b008232e7f` |

The golden input, complete canonical result, reviewer and source identity are versioned
in `fiscal/fixtures/rtc-v0057-model55-normal-sale-sp-2026-01.json`. The rollout locked
document `1facaed2-7034-415f-b64e-ff8636e3a120`, deactivated all three rules, replayed
the identical result while inactive, and restored activation. The active rule IDs are:

- CBS: `aaa6f7d7-057b-5584-b718-8d9c14a16334`;
- IBS_UF: `0b2a52b0-b339-5476-8f48-815025e8313e`;
- IBS_MUN: `92c5c7ea-a1c0-5763-bc41-3bb5b56df70c`.

## Automated and database evidence

- Fiscal lint and typecheck passed.
- 34 Fiscal unit/API tests passed, including the approved golden fixture.
- 14 PostgreSQL/Testcontainers integration tests passed.
- `make up-fiscal` built the service, applied migrations `0010` through `0018`, and
  reached healthy state.
- The approved document is `validated` with one immutable calculation binding and the
  three digests above.
- `GET /capabilities?model=55` remains empty with `defaultStatus: unsupported`, because
  authority issuance capabilities begin in Phase 42; calculation support is exercised
  through preview, lock and replay.

## Final Kong smoke

The repeatable command is:

```sh
make smoke-phase41 \
  TENANT=01a0b6b8-c334-7136-8144-e48a7ba17e08 \
  DOCUMENT=1facaed2-7034-415f-b64e-ff8636e3a120 \
  EXPECT_EXPLANATION=1
```

At `2026-09-22T14:02:34.963Z`, the deliberately unsupported preview returned `422`,
`MISSING_CLASSIFICATION`, stable input digest and `Cache-Control: private, no-store`.
The frozen explanation returned `200` with the approved result digest. Public
`validate` and `issue` each returned `409 No Fiscal authority capability is enabled`.
Database counts were identical before and after:

| Table group | Before | After |
|---|---:|---:|
| Documents | 1 | 1 |
| Calculations / bindings | 1 / 1 | 1 / 1 |
| Transitions / audit entries | 2 / 2 | 2 / 2 |
| Outbox / number reservations | 0 / 0 | 0 / 0 |
| Authority attempts / responses | 0 / 0 | 0 / 0 |

## Delivery conclusion

All Phase 41 exit gates are recorded: official-byte pinning, explicit approval, approved
golden output, immutable document lock, deterministic
replay, rollback/recovery, positive explanation smoke, negative unsupported behavior and
blocked authority operations. Production transmission remains Phase 42 scope.
