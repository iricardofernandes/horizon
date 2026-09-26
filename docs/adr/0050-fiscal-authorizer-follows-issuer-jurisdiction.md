# 50. The NF-e authorizer follows the issuer's jurisdiction

- Status: accepted and implemented locally; exercised against an emulated authorizer
- Date: 2026-09-26

## Context

Phase 43 was written for one candidate tuple: an SP issuer, the SEFAZ-SP homologation
host, `cUF` 35 in every request and response check, and eight database triggers that
refused any capability outside `SP`. Horizon is multi-tenant: every tenant has its own
legal entity, A1 certificate and registered address. An NF-e must go to the authorizer
of the issuer's UF: the state's own SEFAZ, SVRS or SVAN. `cUF`, `cOrgao`, the access key
prefix and `cMunFG` all come from that address. Fixing SP in code would make every
other tenant unsupported by construction rather than by missing review.

## Decision

The issuer's registered address is the only source of jurisdiction. Identity already
stores an IBGE municipality code with the UF (ADR 0049). Fiscal derives
`{uf, ufCode, municipalityCode}` from that address. It refuses an address whose
municipality code does not start with the UF's IBGE code, and it never guesses one
from the city name. The normal-sale operation stays intrastate: the recipient's UF
must equal the issuer's.

A capability names its UF (`jurisdiction_code`). Readiness, manual origins and the
public create route select the capability whose UF matches the issuer, instead of
comparing with `'SP'`. The database keeps the tuple consistent with
`fiscal_nfe_uf_code()`. A model 55/65 capability must name one of the 27 UFs, and an
access key must start with its capability's UF code.

The authorizer comes from a reviewed relation in code
(`src/nfe55/sefaz-authorizers.ts`), read from the national portal on 2026-09-26:
- MA uses SVAN.
- AC, AL, AP, CE, DF, ES, PA, PB, PI, RJ, RN, RO, RR, SC, SE and TO use SVRS.
- AM, BA, GO, MG, MS, MT, PE, PR, RS and SP use their own authorizer.

Each authorizer's five homologation URLs are pinned from the official list. The
transport accepts only a complete published set and derives the authorizer from it.
The adapter is built for one UF and checks that UF's code in every request and
response. Its version is per authorizer (`nfe55-<authorizer>-homologation-v1`), so
existing SP bindings and endpoint digests are unchanged.

The worker resolves each exchange's UF through its grant and capability. It then loads
the establishment's encrypted A1 and the reviewed SOAP operations configured for that
authorizer. A UF whose authorizer has no reviewed operations stays closed. One worker
therefore serves tenants in different states, each with its own certificate.

Tax content remains data. Rule packages are scoped by origin and destination UF, and a
UF without an approved package is `unsupported`, even when its authorizer is
configured.

A local emulator (`SefazHomologationEmulator`) reproduces one authorizer for simulation
environments. The official request bytes go to a loopback route. TLS still verifies
the official hostname against a test root. The route changes the endpoint digest and
marks the drill grant `authority = 'emulated'`. The runner refuses a transport whose
authority differs from the grant. The database refuses emulated exchanges as
activation evidence. Emulated results can prove the code path, but they can never make
a tuple `homologated`.

## Consequences

- Adding a UF needs no code change. It needs a tenant address, a reviewed rule
  package, that authorizer's reviewed SOAP operations and WSDL digest, and the tenant's
  A1. It still needs its own homologation evidence before activation.
- If the official UF relation or endpoint list changes, the registry and its
  retrieval digest must be updated. A stale entry fails closed: the transport refuses
  URLs that are not in the set.
- Interstate sales, SVC contingency, NFC-e and NFS-e remain separate capabilities.
  NFS-e is municipal and will key on the municipality code, not the UF.
- The emulator mirrors the adapter's current SOAP envelope, including the operation
  wrapper. The official WSDL is still unreviewed; if it publishes `nfeDadosMsg`
  directly in the body, the adapter and the emulator change together.
