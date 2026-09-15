export function PageHeading({
  eyebrow,
  title,
  copy,
}: {
  eyebrow: string
  title: string
  copy: string
}) {
  return (
    <header className="page-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{copy}</p>
    </header>
  )
}

export function PanelHeading({ title, copy }: { title: string; copy: string }) {
  return (
    <header className="panel-heading">
      <div>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
    </header>
  )
}

export function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  )
}
