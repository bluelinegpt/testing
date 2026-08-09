import type { ReactNode } from "react";

/**
 * One labelled checkout field with local validation presentation. The error is
 * tied to the control via `aria-describedby`, so screen readers announce it
 * with the field rather than as loose text.
 */
export function CheckoutField({
  children,
  error,
  id,
  label,
  optional = false,
}: {
  readonly children: (props: {
    readonly "aria-describedby": string | undefined;
    readonly "aria-invalid": boolean;
    readonly id: string;
  }) => ReactNode;
  readonly error?: string | undefined;
  readonly id: string;
  readonly label: string;
  readonly optional?: boolean;
}) {
  const errorId = error === undefined ? undefined : `${id}-error`;
  return (
    <div className={`sf-field${error === undefined ? "" : " sf-invalid"}`}>
      <label htmlFor={id}>
        <span>
          {label} {optional ? <em className="sf-optional">(optional)</em> : null}
        </span>
      </label>
      {children({ "aria-describedby": errorId, "aria-invalid": error !== undefined, id })}
      {error === undefined ? null : (
        <p className="sf-field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
