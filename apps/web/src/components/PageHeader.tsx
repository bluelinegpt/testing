import type { ReactNode } from "react";

export function PageHeader({
  actions,
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode;
  description?: string;
  eyebrow?: string;
  title: string;
}) {
  return (
    <header className="page-heading">
      <div className="page-heading-copy">
        {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description === undefined ? null : <p className="page-description">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="heading-actions">{actions}</div>}
    </header>
  );
}
