export function Empty({ copy }: { copy: string }) {
  return <p className="empty">{copy}</p>
}

export function LoadingState({ copy = 'Preparing your workspace…' }: { copy?: string }) {
  return (
    <div className="loading" aria-live="polite">
      <span className="loading-mark">H</span>
      <p>{copy}</p>
    </div>
  )
}

export function Notice({ copy }: { copy: string }) {
  return (
    <div className="notice" role="status">
      {copy}
    </div>
  )
}
