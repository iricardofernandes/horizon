const roots = new Set([
  'catalog',
  'financial',
  'identity',
  'inventory',
  'parties',
  'sales',
  'treasury',
  'ledger',
  'procurement',
  'webhooks',
])

export function buildUpstreamPath(path: string[], search = ''): string | null {
  if (
    !path[0] ||
    !roots.has(path[0]) ||
    path.some((segment) => !segment || segment === '.' || segment === '..')
  )
    return null

  return `/${path.map(encodeURIComponent).join('/')}${search}`
}
