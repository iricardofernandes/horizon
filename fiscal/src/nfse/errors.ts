/** Stable refusals of the national NFS-e flow (`fiscalServiceProblemCodeSchema`). */

/** The national system does not issue for this municipality on this competence date. */
export class MunicipalityUnsupported extends Error {
  readonly code = 'MUNICIPALITY_UNSUPPORTED'
}

/** No reviewed service fiscal profile revision covers the service at the competence date. */
export class ServiceProfileMissing extends Error {
  readonly code = 'SERVICE_PROFILE_MISSING'
}

/** The NFS-e cannot be substituted (state, window, a live substitute or changed facts). */
export class SubstitutionNotAllowed extends Error {
  readonly code = 'SUBSTITUTION_NOT_ALLOWED'
}

/** The same owner fact (source key) was already frozen with different facts. */
export class SourceKeyConflict extends Error {
  readonly code = 'SOURCE_KEY_CONFLICT'
}

/** Event 101101 after the municipality's cancellation window (E0822). */
export class ServiceCancellationWindowElapsed extends Error {
  readonly code = 'CANCELLATION_WINDOW_ELAPSED'
  constructor(readonly windowDays: number) {
    super(`The NFS-e cancellation window of ${windowDays} days has elapsed (E0822)`)
  }
}
