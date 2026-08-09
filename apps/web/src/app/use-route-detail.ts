import { useCallback, useState } from "react";

import {
  recordListRoute,
  recordRoute,
  type RoutableRecord,
} from "../features/accounting/accounting-routes.js";
import { useSessionAccess } from "./SessionAccessContext.js";

/**
 * Makes an existing list-and-dialog workspace addressable by URL without
 * duplicating its detail screen.
 *
 * These workspaces already own one detail component each; it simply opened
 * from local state, so the record had no address and could not survive a
 * refresh, be pasted into a new tab, or be linked to from a Journal or an
 * Accounting Event.
 *
 * With this hook the same state is driven from the URL instead:
 *
 *  - clicking a row navigates to the record's canonical route, which seeds the
 *    state and opens the SAME dialog with the SAME data loading, permissions,
 *    formatting and Related Records — there is no second implementation to
 *    drift;
 *  - closing navigates back to the list, which stayed mounted underneath with
 *    its filters, sorting and page intact;
 *  - a directly-opened or refreshed URL lands on exactly the same screen.
 *
 * The route is built from `accounting-routes.ts`, the single central mapping,
 * so no route string is written twice.
 *
 * Outside the session provider (tests, stories) it degrades to the previous
 * local-state behaviour rather than throwing.
 */
export function useRouteDetail(
  recordType: RoutableRecord,
  routeId: string | undefined,
): {
  readonly close: () => void;
  readonly detailId: string | undefined;
  readonly open: (id: string) => void;
} {
  const session = useSessionAccess();
  const [localId, setLocalId] = useState<string>();
  const detailId = routeId ?? localId;

  const open = useCallback(
    (id: string) => {
      const path = session === undefined ? undefined : recordRoute(recordType, id);
      if (path === undefined) {
        setLocalId(id);
        return;
      }
      // Navigating is what makes the record addressable; the route then seeds
      // `routeId` and the dialog opens from there.
      session?.navigate(path);
    },
    [recordType, session],
  );

  const close = useCallback(() => {
    setLocalId(undefined);
    if (routeId === undefined) return;
    // A route-opened detail closes by returning to its list. `navigate` pushes,
    // so browser Back still walks the trail the User actually took.
    const list = recordListRoute(recordType);
    if (list !== undefined) session?.navigate(list);
  }, [recordType, routeId, session]);

  return { close, detailId, open };
}
