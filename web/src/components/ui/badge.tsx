export function Badge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status.replace('-', ' ')}</span>
}
