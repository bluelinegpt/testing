# Follow-up investigation: Driver return status mismatch

## Scope

Investigate and resolve the Driver-return status mismatch only. Do not change
the behaviour as part of this investigation prompt without first selecting an
option below. Do not query or mutate production as part of this task.

## Source evidence to verify

- Flutter maps `DriverAction.returnToBranch` to `returned_to_branch` and sends
  that value to `PATCH /portal/driver/orders/:id/status`.
- The current backend Driver transition map allows
  `out_for_delivery -> in_branch` (alongside its other Driver transitions),
  but does **not** list `returned_to_branch` as a permitted target for the
  Driver endpoint. On this source path, a Driver request carrying
  `returned_to_branch` should fail with `order_status_transition_invalid`.
- `returned_to_branch` is handled in the Office workflow as a branch-return
  processing state, with a later Office transition to `returned_to_trader`.
- `in_branch` is currently excluded from the Driver work-list predicate. If a
  Driver return is accepted as `in_branch`, the returned parcel disappears
  from the Driver's list, which may be intentional ownership transfer but must
  be explicitly confirmed in the product workflow.

## Questions to answer with repository evidence

1. Confirm the exact Flutter action, endpoint, payload and local source line
   references for a Driver return.
2. Confirm whether the deployed application revision has the same transition
   map. Do not call production: use the deployed revision/source provenance
   available in the repository or deployment metadata. State clearly whether
   the Driver PATCH currently succeeds or fails on that revision. This is the
   operational question: if it fails, Drivers have no working way to complete
   a return today.
3. Explain the six existing production `returned_to_branch` history rows using
   evidence. Candidate explanations to investigate are: an Office/Operator
   transition, a legacy deployment whose Driver transition map differed, or a
   controlled data import. Do not assert one without evidence.
4. Confirm whether `in_branch` is the intended Driver-return result and,
   if it is, document that it is not shown in the Driver list and which Office
   queue then owns it.

## Fix options — analyse only; do not choose one in this task

1. Make Flutter submit `in_branch`, retaining branch ownership after a Driver
   return; add clear Driver confirmation and Office handover visibility.
2. Permit `returned_to_branch` in the Driver transition map, preserving the
   existing Flutter payload; define whether it remains visible to the Driver
   until an Office acknowledgement.
3. Introduce an explicit Driver-return event/action that atomically moves the
   Order to the chosen branch queue, records custody handover metadata, and
   gives each role its correct visibility.

For every option, assess mobile compatibility, role ownership, Driver list
visibility, audit history, notification effects, and migration/backwards
compatibility. Add focused tests before any implementation.
