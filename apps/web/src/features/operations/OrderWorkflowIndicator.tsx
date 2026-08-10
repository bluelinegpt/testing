import { AlertTriangle, CheckCircle2, Clock, Info, MinusCircle } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

/**
 * "What is this Order waiting for?" — one chip per row, with the explanation
 * behind it.
 *
 * ===========================================================================
 * THIS COMPONENT DECIDES NOTHING
 * ===========================================================================
 *
 * Every value shown is `guidance`, derived on the SERVER from the four
 * authoritative statuses. Nothing is inferred here from displayed text, and
 * opening, closing or clicking anything in this popover cannot change an Order:
 * the next action is a LINK to an existing screen, never a submission. No
 * collection, settlement, confirmation or posting is performed from here.
 *
 * ===========================================================================
 * WHY NOT A `title` ATTRIBUTE
 * ===========================================================================
 *
 * A native tooltip cannot be reached by keyboard, cannot hold a link, and is
 * unreadable to a screen reader in the order the content is written. This is a
 * real popover: hover OR focus opens it, Escape closes it, and the trigger owns
 * `aria-expanded`/`aria-controls` so assistive technology can announce it.
 *
 * It is deliberately NOT a click-to-navigate row: clicks inside the popover act
 * only on the control the user chose, so row checkboxes, bulk selection and the
 * per-row action menu keep working exactly as before.
 */

export interface OrderWorkflowGuidance {
  readonly completionBlockerCode: string | null;
  readonly isFinanciallyComplete: boolean;
  readonly nextActionCode: string;
  readonly nextActionParams: Readonly<Record<string, string>>;
  readonly nextActionRoute: string | null;
  readonly waitingFor: string;
  readonly workflowState: string;
}

/** Tone per state. Colour REINFORCES the words; it never carries them alone. */
const stateTone: Readonly<Record<string, "blue" | "amber" | "green" | "red" | "gray">> = {
  awaiting_accounting_posting: "amber",
  awaiting_delivery: "blue",
  awaiting_driver_assignment: "blue",
  awaiting_driver_collection: "amber",
  awaiting_return_processing: "amber",
  awaiting_trader_payment: "amber",
  awaiting_trader_receipt_confirmation: "blue",
  blocked: "red",
  complete: "green",
  no_accounting_required: "gray",
};

const stateIcon = {
  amber: Clock,
  blue: Info,
  gray: MinusCircle,
  green: CheckCircle2,
  red: AlertTriangle,
} as const;

/** Permission required per action code, mirroring the backend metadata map. */
const actionPermissions: Readonly<Record<string, readonly string[]>> = {
  // Navigation-only actions are NOT gated here: the destination screen already
  // enforces its own permissions, and hiding a read-only link would leave the
  // user with an explanation and no way to look at the record.
  assign_driver: ["orders.assign_driver"],
  close_order: ["orders.update_delivery_status"],
  collect_from_driver: ["reconciliations.create"],
  confirm_trader_received: ["settlements.create"],
  none: [],
  open_accounting: [],
  open_order: [],
  open_journal: [],
  open_settlement: [],
  review_account_mapping: [],
  review_duplicate_posting: [],
  review_fiscal_period: [],
  pay_trader: ["settlements.create"],
  review_return: [],
  view_collection: [],
};


const administrator = "users_roles.manage";

function allowed(permissions: readonly string[], code: string): boolean {
  const required = actionPermissions[code] ?? [];
  if (required.length === 0) return true;
  if (permissions.includes(administrator)) return true;
  return required.some((one) => permissions.includes(one));
}


/** Viewport padding kept clear on every side, so nothing touches the edge. */
const viewportPadding = 12;
/** Gap between the trigger and the panel. */
const triggerGap = 6;

interface PanelPosition {
  readonly left: number;
  readonly maxHeight: number;
  readonly top: number;
}

/**
 * Places the panel against the trigger, then pulls it back inside the viewport.
 *
 * Everything is computed from live `getBoundingClientRect()` values and applied
 * as `position: fixed`, so the result is independent of every ancestor the row
 * happens to sit inside. That is what makes clipping impossible rather than
 * merely unlikely.
 *
 * Flip before shift: if the panel does not fit below the trigger it moves
 * ABOVE, and only then is it nudged horizontally. Doing it the other way round
 * produces a panel that covers the row it describes.
 */
function positionPanel(trigger: DOMRect, panel: DOMRect): PanelPosition {
  const viewportWidth = globalThis.innerWidth;
  const viewportHeight = globalThis.innerHeight;

  const spaceBelow = viewportHeight - trigger.bottom - triggerGap - viewportPadding;
  const spaceAbove = trigger.top - triggerGap - viewportPadding;
  // Open upward only when below genuinely will not do AND above is roomier.
  const openAbove = panel.height > spaceBelow && spaceAbove > spaceBelow;

  const maxHeight = Math.max(120, openAbove ? spaceAbove : spaceBelow);
  const height = Math.min(panel.height, maxHeight);
  const top = openAbove ? trigger.top - triggerGap - height : trigger.bottom + triggerGap;

  // Start aligned to the trigger's inline start, then clamp into the viewport.
  // The clamp is what handles both the right and the left edge, in LTR and RTL
  // alike, without a hardcoded offset anywhere.
  const preferred = trigger.left;
  const maximumLeft = viewportWidth - panel.width - viewportPadding;
  const left = Math.max(viewportPadding, Math.min(preferred, maximumLeft));

  return { left, maxHeight, top };
}

export function OrderWorkflowIndicator({
  guidance,
  statuses,
  permissions,
  onNavigate,
  orderNumber,
}: {
  readonly guidance: OrderWorkflowGuidance;
  readonly onNavigate: (path: string) => void;
  /** Used only by the secondary View Order control. */
  readonly orderNumber?: string | undefined;
  readonly permissions: readonly string[];
  readonly statuses: {
    readonly accounting: string;
    readonly delivery: string;
    readonly driverCash: string;
    readonly return: string | null;
    readonly settlement: string;
  };
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const panelId = useId();
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /* Pointer travel between the trigger and the portalled panel leaves the
     wrapper entirely, so an immediate close would dismiss the panel the moment
     the user reached for its button. A short grace period covers the gap. */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Escape closes the panel AND returns focus to the trigger. Without this
     flag that focus immediately re-fires `onFocus` and reopens what the user
     just dismissed, so Escape appeared to do nothing at all. */
  const suppressFocusOpen = useRef(false);

  // Escape closes, and the trigger takes focus back so the keyboard user is
  // not dropped at the top of the document.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      suppressFocusOpen.current = true;
      wrapperRef.current?.querySelector("button")?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const reposition = useCallback(() => {
    const trigger = wrapperRef.current;
    const panel = panelRef.current;
    if (trigger === null || panel === null) return;
    setPosition(positionPanel(trigger.getBoundingClientRect(), panel.getBoundingClientRect()));
  }, []);

  // Measured before paint, so the panel never appears at 0,0 and jump.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    // `capture` catches scrolling in ANY ancestor -- including the Orders
    // table's own horizontal scroll container, which does not bubble.
    globalThis.addEventListener("scroll", reposition, true);
    globalThis.addEventListener("resize", reposition);
    return () => {
      globalThis.removeEventListener("scroll", reposition, true);
      globalThis.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  // Outside click closes. Pointerdown rather than click, so the panel is gone
  // before the underlying control reacts.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (wrapperRef.current?.contains(target ?? null) === true) return;
      if (panelRef.current?.contains(target ?? null) === true) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  const cancelClose = () => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  const tone = stateTone[guidance.workflowState] ?? "gray";
  const Icon = stateIcon[tone];
  const label = t(`orderWorkflow.state.${guidance.workflowState}`);
  const canAct =
    guidance.nextActionRoute !== null && allowed(permissions, guidance.nextActionCode);

  const actionHref = () => {
    if (guidance.nextActionRoute === null) return null;
    const params = new URLSearchParams(guidance.nextActionParams);
    const query = params.toString();
    return query === "" ? guidance.nextActionRoute : `${guidance.nextActionRoute}?${query}`;
  };

  return (
    <span
      className="order-workflow"
      onBlur={(event) => {
        // Closes only when focus leaves the whole control, so tabbing from the
        // trigger INTO the action link does not dismiss it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
      ref={wrapperRef}
    >
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className={`order-workflow-chip order-workflow-${tone}`}
        onClick={() => setOpen((current) => !current)}
        onFocus={() => {
          if (suppressFocusOpen.current) {
            suppressFocusOpen.current = false;
            return;
          }
          setOpen(true);
        }}
        type="button"
      >
        <Icon aria-hidden="true" size={13} />
        <span>{label}</span>
      </button>

      {/* Portalled to <body>. The Orders table sits inside `overflow: clip`
          (`.orders-workspace`) and `overflow-x: auto` (`.orders-table-scroll`);
          any panel rendered inside that subtree is clipped by them, which is
          what cut the right-hand rows in half. Escaping to the body removes the
          clipping ancestors from the equation entirely rather than weakening
          the table's own overflow, which the sticky scrollbar depends on. */}
      {open
        ? createPortal(
        <div
          aria-label={label}
          className="order-workflow-panel"
          id={panelId}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          ref={panelRef}
          role="dialog"
          style={{
            left: position === null ? -9999 : position.left,
            maxHeight: position === null ? undefined : position.maxHeight,
            top: position === null ? -9999 : position.top,
            // Hidden until measured, so it never flashes at the wrong place.
            visibility: position === null ? "hidden" : "visible",
          }}
        >
          <dl className="order-workflow-statuses">
            <dt>{t("orderWorkflow.fields.delivery")}</dt>
            <dd>{t(`statuses.${statuses.delivery}`, { defaultValue: statuses.delivery })}</dd>
            <dt>{t("orderWorkflow.fields.driverCash")}</dt>
            <dd>{t(`orderWorkflow.driverCash.${statuses.driverCash}`, statuses.driverCash)}</dd>
            <dt>{t("orderWorkflow.fields.settlement")}</dt>
            <dd>{t(`statuses.${statuses.settlement}`, { defaultValue: statuses.settlement })}</dd>
            <dt>{t("orderWorkflow.fields.accounting")}</dt>
            <dd>{t(`orderWorkflow.accounting.${statuses.accounting}`, statuses.accounting)}</dd>
            {statuses.return === null || statuses.return === "" ? null : (
              <>
                <dt>{t("orderWorkflow.fields.return")}</dt>
                <dd>{t(`statuses.${statuses.return}`, { defaultValue: statuses.return })}</dd>
              </>
            )}
          </dl>

          {/* The NEXT STEP is the strongest line in the panel. "Waiting for"
              describes a state; an operator needs the instruction, so when an
              action exists it is what they read first. */}
          {guidance.nextActionCode === "none" ? (
            <p className="order-workflow-waiting">
              <strong>{t("orderWorkflow.waitingForLabel")}</strong>{" "}
              {t(`orderWorkflow.waitingFor.${guidance.waitingFor}`)}
            </p>
          ) : (
            <p className="order-workflow-nextstep">
              <span className="order-workflow-nextstep-label">
                {t("orderWorkflow.nextStepLabel")}
              </span>
              <strong>{t(`orderWorkflow.action.${guidance.nextActionCode}`)}</strong>
            </p>
          )}

          <p className="order-workflow-why">
            {guidance.completionBlockerCode === null
              ? t(`orderWorkflow.why.${guidance.workflowState}`)
              : t(`orderWorkflow.blocker.${guidance.completionBlockerCode}`)}
          </p>

          <div className="order-workflow-actions">
            {guidance.nextActionRoute === null ? null : canAct ? (
              <button
                className="order-workflow-action"
                onClick={() => {
                  const href = actionHref();
                  // A LINK, not a submission. The target screen still enforces
                  // every permission and performs nothing on arrival.
                  if (href !== null) onNavigate(href);
                }}
                type="button"
              >
                {t(`orderWorkflow.action.${guidance.nextActionCode}`)}
              </button>
            ) : (
              <p className="order-workflow-denied" role="status">
                {t("orderWorkflow.noPermission")}
              </p>
            )}
            {/* Secondary, and never the primary: opening the Order is what the
                operator would have done without any guidance at all. */}
            {orderNumber === undefined ? null : (
              <button
                className="order-workflow-secondary"
                onClick={() => onNavigate(`/orders/${encodeURIComponent(orderNumber)}`)}
                type="button"
              >
                {t("orderWorkflow.viewOrder")}
              </button>
            )}
          </div>
        </div>,
            document.body,
          )
        : null}
    </span>
  );
}
