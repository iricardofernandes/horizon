const roots = new Set(['catalog', 'identity', 'inventory', 'parties', 'sales', 'webhooks'])

export function buildUpstreamPath(path: string[], search = ''): string | null {
  if (
    !path[0] ||
    !roots.has(path[0]) ||
    path.some((segment) => !segment || segment === '.' || segment === '..')
  )
    return null

  return `/${path.map(encodeURIComponent).join('/')}${search}`
}
