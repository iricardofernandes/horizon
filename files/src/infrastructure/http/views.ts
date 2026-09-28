import type { Attachment as AttachmentView } from '@horizon/contracts'
import type { Attachment } from '@/domain/attachment'

/** The published shape: no owner, key or storage detail leaves `files`. */
export function viewOf(attachment: Attachment): AttachmentView {
  return {
    id: attachment.id,
    module: attachment.module,
    recordType: attachment.recordType,
    recordId: attachment.recordId,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    size: attachment.size,
    sha256: attachment.sha256,
    status: attachment.status,
    deletionReason: attachment.deletionReason,
    finding: attachment.finding,
    uploadedBy: attachment.uploadedBy,
    createdAt: attachment.createdAt.toISOString(),
    availableAt: attachment.availableAt?.toISOString() ?? null,
    expiresAt:
      attachment.status === 'available' ? (attachment.expiresAt?.toISOString() ?? null) : null,
  }
}
