import type { DataSubjectKey } from '@/domain/entities/data-subject-key'

export abstract class DataSubjectKeysRepository {
  abstract findBySubject(subjectId: string): Promise<DataSubjectKey | null>
  abstract create(key: DataSubjectKey): Promise<void>
  abstract save(key: DataSubjectKey): Promise<void>
}
