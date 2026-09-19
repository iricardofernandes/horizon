import { TITLE_ORIGINS, type TitleOrigin, type TitleOriginType } from '@/domain/entities/title'

/**
 * The stored origin, read back.
 *
 * A row whose type is unknown to this build reads as manual rather than throwing: the
 * origin is where a title came from, not what it means, and refusing to load a title
 * because a newer version raised it from something new would be a worse answer than
 * showing it without its provenance.
 */
export function originOf(type: string, documentId: string | null): TitleOrigin {
  if (type === 'manual' || !documentId) return { type: 'manual' }
  if (!(TITLE_ORIGINS as readonly string[]).includes(type)) return { type: 'manual' }
  return { type: type as Exclude<TitleOriginType, 'manual'>, documentId }
}
