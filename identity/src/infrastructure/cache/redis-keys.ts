const segment = (value: string): string => Buffer.from(value).toString('base64url')

/** Tenant hash tags keep multi-key scripts in one Redis Cluster slot. */
export const redisKeys = {
  family: (tenantId: string, familyId: string): string =>
    `identity:refresh:{${segment(tenantId)}}:family:${segment(familyId)}`,
  userFamilies: (tenantId: string, userId: string): string =>
    `identity:refresh:{${segment(tenantId)}}:user:${segment(userId)}`,
  deniedToken: (jti: string): string => `identity:denylist:jti:${segment(jti)}`,
  deniedSubject: (subject: string): string => `identity:denylist:subject:${segment(subject)}`,
  workspaceSelection: (digest: string): string => `identity:workspace-selection:${segment(digest)}`,
}
