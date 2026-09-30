# 72. A tax scenario is supported only with evidence

- Status: accepted. The oracle is implemented in Phase 84 and the support matrix in Phase
  85.
- Date: 2026-09-30

## Context

A reviewer without Brazilian tax knowledge cannot judge whether a calculation is right,
and the engine must never infer tax treatment it was not given. Phase 41 approved one
scenario through the workspace owner's review of a fixture built from the official
calculator.

## Decision

- **IBS, CBS and Imposto Seletivo scenarios are supported when the official calculator
  agrees** with Horizon on every case of the scenario corpus. The calculator is the Receita
  Federal/SERPRO offline distribution, pinned by digest.
- **Legacy-tax scenarios** (ICMS, IPI, PIS/Cofins, ISS) are supported when the workspace
  owner approved their fixture, as in Phase 41, since no single official oracle exists for
  them.
- **The support matrix is generated from that evidence,** never written by hand. Any other
  scenario answers `unsupported`, naming the missing dimension, and cannot be transmitted.
- **A new calculator version is a new source.** It holds the matrix until the corpus is run
  against it.

## Consequences

- The matrix grows at the pace of evidence, and "unsupported" is an honest answer.
- The oracle runs in its own CI workflow, on package changes and weekly, since its image is
  large.

## Alternatives considered

**Supporting a scenario because rules exist for it.** Rejected: rules can be wrong in ways
only an independent calculation or a reviewer can show.
