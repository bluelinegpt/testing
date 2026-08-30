import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/core/validation/safe_parsers.dart';

final class DriverOrder {
  const DriverOrder({
    required this.id,
    required this.orderNumber,
    required this.serialNumber,
    this.psystemSerial,
    required this.orderDate,
    required this.areaId,
    required this.areaName,
    required this.customerName,
    required this.customerMobile,
    required this.address,
    required this.expectedCod,
    required this.amountCollected,
    required this.status,
    required this.traderName,
    this.reference,
    this.notes,
    this.emirateNameEn,
    this.emirateNameAr,
  });
  final String id,
      orderNumber,
      serialNumber,
      orderDate,
      areaId,
      areaName,
      customerName,
      customerMobile,
      address,
      expectedCod,
      amountCollected,
      status,
      traderName;
  final String? psystemSerial, reference, notes, emirateNameEn, emirateNameAr;
}

final class DriverOrderHistoryEvent {
  const DriverOrderHistoryEvent({
    required this.toStatus,
    required this.occurredAt,
    this.fromStatus,
  });
  final String? fromStatus;
  final String toStatus;
  final String occurredAt;
}

/// Driver-scoped dashboard counts — never Company-wide, never another
/// Driver's (`portal/driver/dashboard-summary` is scoped entirely
/// server-side to the authenticated Driver).
final class DriverDashboardSummary {
  const DriverDashboardSummary({
    required this.activeTotal,
    required this.assignedToMe,
    required this.deliveredToday,
    required this.outForDelivery,
    required this.returnPending,
  });
  final int activeTotal,
      assignedToMe,
      deliveredToday,
      outForDelivery,
      returnPending;

  /// Kept separate from `ApiDriverRepository` so the response-shape contract
  /// is unit-testable without a real or faked network call — a missing or
  /// malformed required field fails loud, matching the same "never silently
  /// default" rule the rest of the mobile DTO layer follows.
  factory DriverDashboardSummary.fromJson(Map<String, dynamic> value) {
    int required(String key) {
      final result = value[key];
      if (result is! int) {
        throw DriverDashboardParseError('invalid_field_$key');
      }
      return result;
    }

    return DriverDashboardSummary(
      activeTotal: required('activeTotal'),
      assignedToMe: required('assignedToMe'),
      deliveredToday: required('deliveredToday'),
      outForDelivery: required('outForDelivery'),
      returnPending: required('returnPending'),
    );
  }
}

final class DriverDashboardParseError implements Exception {
  const DriverDashboardParseError(this.code);
  final String code;
}

/// One Driver dashboard card: a title, the server-reported count backing it,
/// and the exact `/orders` deep link tapping it should open. Kept as plain
/// data (no widget/BuildContext) so the summary → card → route mapping is
/// unit-testable on its own, without pumping a widget tree — mirrors
/// `OperatorDashboardCard`/`operatorDashboardCards`.
final class DriverDashboardCard {
  const DriverDashboardCard({
    required this.title,
    required this.value,
    required this.route,
  });
  final String title;
  final int value;
  final String route;
}

/// The approved 5-card set for the Driver dashboard, in display order.
/// `l10n` supplies only display strings; every count and route decision is
/// deterministic from `summary` alone.
List<DriverDashboardCard> driverDashboardCards(
  DriverDashboardSummary summary,
  AppLocalizations l10n,
) => [
  DriverDashboardCard(
    title: l10n.myActiveOrders,
    value: summary.activeTotal,
    route: '/orders',
  ),
  DriverDashboardCard(
    title: l10n.assignedToMe,
    value: summary.assignedToMe,
    route: '/orders?deliveryStatus=assigned_to_driver',
  ),
  DriverDashboardCard(
    title: l10n.outForDelivery,
    value: summary.outForDelivery,
    route: '/orders?deliveryStatus=out_for_delivery',
  ),
  DriverDashboardCard(
    title: l10n.deliveredToday,
    value: summary.deliveredToday,
    route: '/orders?deliveryStatus=delivered',
  ),
  DriverDashboardCard(
    title: l10n.returnPending,
    value: summary.returnPending,
    route: '/orders?deliveryStatus=returned_to_branch',
  ),
];

/// Every reachable action a Driver identity can take from this Order's
/// current status. Backend-authoritative (`operations.service.ts`
/// `driverTransitions` inside `changeOrderStatus`) transitions:
/// `assigned_to_driver -> out_for_delivery`, `out_for_delivery ->
/// {hold, delivered, returned_to_branch}`. Nothing else is reachable, so
/// this is the complete set — there is no separate "report failure" concept
/// on the backend, only Return to Branch. Hold is not a new backend status
/// (Operations already had it); this is only what a `driver`-kind identity
/// may reach it from — there is no `hold -> anything` entry anywhere in
/// `driverTransitions`, so once held an Order has zero Driver actions until
/// Operations moves it again.
enum DriverAction { startDelivery, markDelivered, hold, returnToBranch }

Set<DriverAction> actionsForDriverStatus(String status) => switch (status) {
  'assigned_to_driver' || 'assigned' => {DriverAction.startDelivery},
  'out_for_delivery' => {
    DriverAction.markDelivered,
    DriverAction.hold,
    DriverAction.returnToBranch,
  },
  _ => const {},
};

/// The backend `status` body value each Driver action's PATCH targets
/// (`portal/driver/orders/:orderId/status`) — the single source of truth
/// both Driver code paths (genuine `driver`-kind and a Driver User) build
/// their payload from.
String driverActionTargetStatus(DriverAction action) => switch (action) {
  DriverAction.startDelivery => 'out_for_delivery',
  DriverAction.markDelivered => 'delivered',
  DriverAction.hold => 'hold',
  DriverAction.returnToBranch => 'returned_to_branch',
};

/// Mirrors the backend's generic `order_status_reason_required` rule for the
/// two Driver actions that need one — Hold and Return to Branch require the
/// exact same reason-prompt treatment.
bool driverActionRequiresReason(DriverAction action) =>
    action == DriverAction.hold || action == DriverAction.returnToBranch;

bool isSafeCustomerContact(String value) => UaeMobileValidator.isValid(value);

/// Whether the data currently shown for a Driver came from the network just
/// now, or from `driver_orders_cache`/`driver_dashboard_cache` because the
/// live call was unreachable (Prompt 16 §F/§Y). `lastSyncedAt` is `null`
/// only when this identity has never successfully synced this data at all —
/// callers must show the existing offline/error state in that case, never a
/// fabricated "0" or an empty banner timestamp.
final class DriverDataFreshness {
  const DriverDataFreshness({required this.isOffline, this.lastSyncedAt});
  final bool isOffline;
  final DateTime? lastSyncedAt;
}

/// Mirrors `driver_sync_queue.state` (Prompt 16 §J) — the lifecycle of one
/// queued offline status-change action.
enum DriverSyncRowState { pending, syncing, synced, failed, conflict }

/// One durable row of the offline sync queue/outbox — a single Driver
/// status-change action captured while offline (or attempted-and-failed
/// online), replayed in `sequence` order per `orderId` once connectivity
/// returns. `localActionId` is generated once at enqueue time and reused
/// verbatim as the `X-Idempotency-Key` on every retry (Prompt 16 §K) — it is
/// never regenerated for the lifetime of this row.
final class DriverQueueEntry {
  const DriverQueueEntry({
    required this.localActionId,
    required this.companyId,
    required this.driverAccountId,
    required this.orderId,
    required this.targetStatus,
    required this.sequence,
    required this.createdAt,
    required this.state,
    this.reason,
    this.expectedStatus,
    this.retryCount = 0,
    this.nextEligibleAt,
  });

  final String localActionId, companyId, driverAccountId, orderId;
  final String targetStatus;
  final String? reason;

  /// The cached Order status at the moment this action was queued — sent to
  /// the backend as `expectedStatus` so a genuine change that happened while
  /// offline (Order cancelled, reassigned, moved by someone else) is
  /// detected as `order_status_conflict` instead of silently overwritten.
  final String? expectedStatus;
  final int sequence;
  final DateTime createdAt;
  final int retryCount;
  final DriverSyncRowState state;

  /// Bounded-backoff gate (Prompt 16 §M) — this row is not attempted again
  /// until this time has passed, even if a sync pass is triggered sooner.
  final DateTime? nextEligibleAt;

  DriverQueueEntry copyWith({
    int? retryCount,
    DriverSyncRowState? state,
    DateTime? nextEligibleAt,
  }) => DriverQueueEntry(
    localActionId: localActionId,
    companyId: companyId,
    driverAccountId: driverAccountId,
    orderId: orderId,
    targetStatus: targetStatus,
    sequence: sequence,
    createdAt: createdAt,
    reason: reason,
    expectedStatus: expectedStatus,
    retryCount: retryCount ?? this.retryCount,
    state: state ?? this.state,
    nextEligibleAt: nextEligibleAt ?? this.nextEligibleAt,
  );
}
