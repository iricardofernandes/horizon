/**
 * The service fiscal profile of a Catalog service (Phase 47 API, Phase 49 screen): the
 * national tax code, the NBS code and the ISS treatment, in immutable revisions that take
 * effect on a date.
 */
export type ServiceProfile = {
  itemId: string
  revision: number
  nationalTaxCode: string
  nbsCode: string
  municipalTaxCode: string | null
  issTaxation: '1'
  description: string
  effectiveFrom: string
  digest: string
  createdBy: string
  createdAt: string
}

export type ServiceProfileForm = {
  itemId: string
  nationalTaxCode: string
  nbsCode: string
  municipalTaxCode: string
  description: string
  effectiveFrom: string
  reason: string
}

/**
 * The revision in force on a day: the latest one already effective. A revision that only
 * takes effect later is `upcoming`, never current.
 */
export function profileOn(
  revisions: readonly ServiceProfile[],
  day: string,
): { current: ServiceProfile | null; upcoming: ServiceProfile | null } {
  const byRevision = [...revisions].sort((left, right) => right.revision - left.revision)
  const effective = byRevision.filter((profile) => profile.effectiveFrom <= day)
  const current =
    effective.sort(
      (left, right) =>
        right.effectiveFrom.localeCompare(left.effectiveFrom) || right.revision - left.revision,
    )[0] ?? null
  const upcoming =
    byRevision
      .filter((profile) => profile.effectiveFrom > day)
      .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom))[0] ?? null
  return { current, upcoming }
}

/**
 * The request body for a new revision, or the key of the first malformed field. The codes
 * are also checked by Fiscal against the pinned national lists; this only catches typing.
 */
export function profileRequest(
  form: ServiceProfileForm,
): { ok: true; body: Record<string, unknown> } | { ok: false; problem: string } {
  const nationalTaxCode = form.nationalTaxCode.replace(/\D/g, '')
  const nbsCode = form.nbsCode.replace(/\D/g, '')
  if (!/^\d{6}$/.test(nationalTaxCode)) return { ok: false, problem: 'nationalTaxCodeInvalid' }
  if (!/^\d{9}$/.test(nbsCode)) return { ok: false, problem: 'nbsCodeInvalid' }
  if (!form.description.trim()) return { ok: false, problem: 'descriptionRequired' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.effectiveFrom))
    return { ok: false, problem: 'effectiveFromInvalid' }
  if (form.reason.trim().length < 10) return { ok: false, problem: 'reasonTooShort' }
  return {
    ok: true,
    body: {
      itemId: form.itemId,
      nationalTaxCode,
      nbsCode,
      ...(form.municipalTaxCode.trim() ? { municipalTaxCode: form.municipalTaxCode.trim() } : {}),
      issTaxation: '1',
      description: form.description.trim(),
      effectiveFrom: form.effectiveFrom,
      reason: form.reason.trim(),
    },
  }
}

/** Today as the reader's calendar says it, not UTC's: a revision takes effect on a local day. */
export function localToday(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
