/** `status` keeps the English enum value for styling; `label` is what a reader sees. */
export function Badge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge badge-${status}`}>{label ?? status.replace('-', ' ')}</span>
}
