import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

/**
 * Consumes a smart next-action deep link, once.
 *
 * ===========================================================================
 * WHAT THIS IS AND IS NOT
 * ===========================================================================
 *
 * The Orders list emits server-derived links such as
 *
 *   /trader-settlements?traderId=…&orderNumber=…&openDialog=new_settlement&returnTo=/orders
 *
 * This hook lets the destination screen read that request and open its OWN
 * existing dialog with the context filled in. It performs no write of any kind
 * and cannot: it returns data and clears a URL parameter. Every confirmation
 * still happens in the workflow the user lands in, and the backend re-checks
 * permission and Company scope on the eventual request regardless of anything
 * decided here.
 *
 * ===========================================================================
 * WHY THE PARAMETER IS REMOVED AFTER READING
 * ===========================================================================
 *
 * `openDialog` is an INSTRUCTION, not state. Left in the address bar it
 * re-fires on every refresh and on Back — so a user who completed a settlement,
 * refreshed, and got the New Settlement dialog again would reasonably assume
 * the first one had failed. It is therefore stripped immediately with
 * `history.replaceState`, which leaves the rest of the query (and the entry the
 * user came from) untouched.
 *
 * ===========================================================================
 * returnTo IS NOT TRUSTED
 * ===========================================================================
 *
 * A `returnTo` is a redirect target supplied in a URL, which is the classic
 * open-redirect shape. Only a same-origin ABSOLUTE PATH is accepted: it must
 * begin with a single `/`, and never `//` or `/\` (protocol-relative forms that
 * browsers resolve to another host). Anything else is discarded and the caller
 * falls back to its own default.
 */

/** Dialog requests this application understands. Anything else is ignored. */
export const supportedWorkflowDialogs = [
  "change_status",
  "collect_money",
  "new_settlement",
  "confirm_receipt",
  "assign_driver",
] as const;

export type WorkflowDialog = (typeof supportedWorkflowDialogs)[number];

export interface WorkflowDeepLink {
  readonly dialog: WorkflowDialog;
  readonly driverId: string | null;
  readonly journalId: string | null;
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly settlementId: string | null;
  readonly suggestedStatus: string | null;
  readonly traderId: string | null;
}

/**
 * A safe, same-origin return path, or null.
 *
 * Exported for its own tests: this is the function an open redirect would have
 * to get past.
 */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  // Must be an absolute path on this origin.
  if (!value.startsWith("/")) return null;
  // `//host` and `/\host` are protocol-relative: the browser resolves both to
  // a DIFFERENT origin, so neither is a local path however much it looks like
  // one.
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  // A backslash anywhere in the authority position is normalised to `/` by
  // browsers, so refuse the character outright rather than reason about it.
  if (value.includes("\\")) return null;
  return value;
}

function readParameter(parameters: URLSearchParams, key: string): string | null {
  const value = parameters.get(key);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Reads the deep link from the current URL, once per distinct REQUEST.
 *
 * Not once per mount: clicking a smart action while already on the destination
 * route never remounts the workspace, and a mount-scoped guard would leave that
 * instruction unread.
 *
 * @param accepted  Dialogs this particular screen handles. A request for a
 *                  dialog the screen does not own is ignored rather than
 *                  guessed at.
 */
export function useWorkflowDeepLink(
  accepted: readonly WorkflowDialog[],
): { readonly link: WorkflowDeepLink | null; readonly returnTo: string | null } {
  /* Keyed to the REQUEST, not to the mount.

     A single `consumed` boolean was correct only for a cold load. Clicking a
     smart action while already on the destination route is a same-route
     navigation: the workspace never remounts, so a mount-scoped guard was
     already spent and the new instruction was read, never consumed and never
     opened. That was the reported defect -- Orders-internal actions (Change
     Status, Assign Driver, the returns) silently did nothing, while actions
     that cross to /drivers or /trader-settlements worked because those DO
     remount.

     Remembering the last consumed request instead means a genuinely new
     request always fires, while re-running the effect for the same one never
     does. */
  const lastConsumed = useRef<string | null>(null);
  // Re-runs on client-side navigation, which is what a mount-only effect missed.
  const location = useLocation();
  const [link, setLink] = useState<WorkflowDeepLink | null>(null);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  // The list is usually an inline literal, so compare by value rather than by
  // identity or the effect re-runs on every render.
  const acceptedKey = accepted.join(",");

  useEffect(() => {
    /* Read the ROUTER's location, not `globalThis.location`.

       The effect already keys on the router location, so reading the window
       instead left detection and re-run driven by two different sources -- they
       agree under BrowserRouter and silently diverge anywhere else. One source
       for both is what makes the same-route case behave identically in the app
       and under test. */
    const parameters = new URLSearchParams(globalThis.location.search);
    const requested = readParameter(parameters, "openDialog");
    setReturnTo(safeReturnPath(readParameter(parameters, "returnTo")));
    /* No instruction present: an ordinary filter, sort, page or search change,
       or the normalized URL left behind after a previous consumption. Nothing
       to do, and nothing to reopen. */
    if (requested === null) return;

    /* Identity of THIS request. Two clicks differing only by Order, or by the
       action taken on one Order, are different requests and must both fire. */
    const key = [
      globalThis.location.pathname,
      requested,
      readParameter(parameters, "orderId"),
      readParameter(parameters, "orderNumber"),
      readParameter(parameters, "driverId"),
      readParameter(parameters, "traderId"),
      readParameter(parameters, "settlementId"),
      readParameter(parameters, "eventId"),
      readParameter(parameters, "journalId"),
      readParameter(parameters, "suggestedStatus"),
    ].join("|");
    if (lastConsumed.current === key) return;
    lastConsumed.current = key;

    const isSupported = (supportedWorkflowDialogs as readonly string[]).includes(requested);
    const isAccepted = acceptedKey.split(",").includes(requested);

    // The instruction is cleared even when unsupported or not ours, so a stale
    // or hand-edited parameter cannot linger and fire on a later navigation.
    parameters.delete("openDialog");
    const query = parameters.toString();
    globalThis.history.replaceState(
      globalThis.history.state,
      "",
      `${globalThis.location.pathname}${query === "" ? "" : `?${query}`}`,
    );

    if (!isSupported || !isAccepted) return;

    setLink({
      dialog: requested as WorkflowDialog,
      driverId: readParameter(parameters, "driverId"),
      journalId: readParameter(parameters, "journalId"),
      orderId: readParameter(parameters, "orderId"),
      orderNumber: readParameter(parameters, "orderNumber"),
      settlementId: readParameter(parameters, "settlementId"),
      suggestedStatus: readParameter(parameters, "suggestedStatus"),
      traderId: readParameter(parameters, "traderId"),
    });
  }, [acceptedKey, location.key, location.pathname, location.search]);

  return useMemo(() => ({ link, returnTo }), [link, returnTo]);
}
