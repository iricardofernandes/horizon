import Link from 'next/link'

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

/** A figure with its label; `link` leads to where the figure can be acted on. */
export function Stat({
  label,
  value,
  note,
  link,
}: {
  label: string
  value: string
  note: string
  link?: { href: string; label: string } | undefined
}) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
      {link ? (
        <Link className="stat-link" href={link.href}>
          {link.label}
        </Link>
      ) : null}
    </article>
  )
}
