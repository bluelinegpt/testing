import type { ReactNode } from "react";

/**
 * Mixing Latin data into Arabic text.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Arabic pages contain Latin strings that Traders typed: Product names, brands,
 * SKUs, prices. The Unicode bidirectional algorithm decides how those run
 * inside surrounding RTL text, and left to itself it gets several of them
 * visibly wrong.
 *
 * The failure is not theoretical. `DEV-ABAYA-0001` next to an Arabic label
 * renders with the hyphen-separated groups reordered, so the customer is shown
 * a code that is not the code. Worse, it looks plausible — nobody notices until
 * somebody quotes it back to support.
 *
 * ---------------------------------------------------------------------------
 * WHY `dir="auto"` IS NOT ENOUGH ON ITS OWN
 * ---------------------------------------------------------------------------
 *
 * `dir="auto"` picks a direction from the FIRST strong character, which is the
 * right call for a whole field of Trader text of unknown language. But it does
 * not isolate that run from its neighbours, so an Arabic label and a Latin
 * value sitting in one line still bleed into each other.
 *
 * `<bdi>` is the element designed for exactly this: it isolates its contents so
 * the surrounding paragraph cannot reorder them and they cannot reorder the
 * paragraph. Combining the two — `<bdi dir="auto">` — gives the correct
 * direction AND the isolation.
 *
 * These are separate components rather than one, because the three cases have
 * genuinely different rules and collapsing them would lose that.
 */

/**
 * Trader-entered prose: Store names, Product names, descriptions.
 *
 * Direction is detected, never assumed. A Trader who writes in Arabic gets RTL
 * and one who writes in English gets LTR, in the same slot on the same page,
 * which is the actual situation in a UAE marketplace.
 */
export function TraderText({
  as: Element = "span",
  className,
  value,
}: {
  readonly as?: "div" | "h1" | "h2" | "h3" | "p" | "span";
  readonly className?: string | undefined;
  readonly value: string;
}) {
  return (
    <Element className={className} dir="auto">
      {value}
    </Element>
  );
}

/**
 * An identifier that must never be reordered: Product code, SKU, barcode.
 *
 * Forced LTR rather than `auto`, and isolated. `auto` would be wrong here — a
 * code that happens to begin with a digit is neutral, so the algorithm would
 * inherit RTL from the Arabic page and flip the segments. These strings are
 * machine identifiers; they have exactly one correct visual order regardless of
 * the language around them.
 */
export function CodeText({
  className,
  value,
}: {
  readonly className?: string | undefined;
  readonly value: string;
}) {
  return (
    <bdi className={className} dir="ltr">
      {value}
    </bdi>
  );
}

/**
 * A price.
 *
 * The currency and the amount are one unit and must not be split across a
 * direction boundary — `AED 249.00` becoming `249.00 AED` on the Arabic page,
 * or worse `AED` landing at the far end of the line, is a real outcome of
 * leaving this to the algorithm.
 *
 * Kept LTR and isolated so the pair always reads the same way. Arabic
 * commerce sites conventionally show Latin-digit prices in this order, so this
 * matches what a shopper here expects rather than fighting it.
 */
export function Money({
  amount,
  className,
  currency,
}: {
  readonly amount: string;
  readonly className?: string | undefined;
  readonly currency: string;
}) {
  return (
    <bdi className={className} dir="ltr">
      {currency} {amount}
    </bdi>
  );
}

/** A label and its isolated value, so neither can reorder the other. */
export function LabelledValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: ReactNode;
}) {
  return (
    <div className="store-fact">
      <dt className="store-fact__label">{label}</dt>
      <dd className="store-fact__value">{value}</dd>
    </div>
  );
}
