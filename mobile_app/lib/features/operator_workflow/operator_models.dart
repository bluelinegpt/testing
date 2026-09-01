import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';

final class OperatorOrder {
  const OperatorOrder({
    required this.id,
    required this.orderNumber,
    required this.serialNumber,
    this.psystemSerial,
    required this.orderDate,
    required this.traderName,
    required this.customerName,
    required this.customerMobile,
    required this.address,
    required this.areaName,
    required this.cod,
    required this.status,
    this.reference,
    this.driverId,
    this.driverName,
    this.notes,
    this.history = const [],
    this.emirateNameEn,
    this.emirateNameAr,
  });
  final String id,
      orderNumber,
      serialNumber,
      orderDate,
      traderName,
      customerName,
      customerMobile,
      address,
      areaName,
      cod,
      status;
  final String? psystemSerial, reference, driverId, driverName, notes;
  final List<OperatorOrderEvent> history;

  /// Present only on the single-Order detail fetch — mirrors the backend's
  /// `OperationsOrder.emirateNameEn`/`emirateNameAr` (`orderById()` only,
  /// never the list query, which doesn't join `emirates`).
  final String? emirateNameEn, emirateNameAr;
}

final class OperatorOrderEvent {
  const OperatorOrderEvent({
    required this.status,
    required this.occurredAt,
    this.fromStatus,
    this.reason,
    this.actor,
  });
  final String status, occurredAt;
  final String? fromStatus, reason, actor;
}

final class OperatorDriver {
  const OperatorDriver({
    required this.id,
    required this.name,
    required this.status,
    required this.type,
    required this.activeOrders,
  });
  final String id, name, status, type;
  final int activeOrders;
  bool get eligible => status == 'active';
}

final class OperatorOrderPage {
  const OperatorOrderPage({
    required this.items,
    required this.page,
    required this.pageSize,
    required this.totalCount,
  });
  final List<OperatorOrder> items;
  final int page, pageSize, totalCount;
  bool get hasMore => page * pageSize < totalCount;
}

const operatorOrderPermissions = {
  'orders.edit_before_processing',
  'orders.assign_driver',
  'orders.update_delivery_status',
  // A Driver User's own permission (the standard Driver role grants exactly
  // this and nothing else). The backend Order list/detail endpoints accept
  // it and independently narrow visibility to the Driver's own assigned
  // Orders — this entry only lets the screen open, mirroring the web app's
  // /orders route gate. Without it, a correctly-provisioned Driver User was
  // blocked client-side with "no permission to view operational Orders"
  // even though every API call would have succeeded.
  'orders.driver_self_service',
  'reconciliations.create',
  'reconciliations.reverse',
  'settlements.create',
  'settlements.reverse',
  'users_roles.manage',
};

/// Server-side counts only — never a client-side download-and-tally of full
/// Order history. `byStatus` always carries every known delivery status key
/// (zero-filled server-side), so `byStatus['out_for_delivery']` is always
/// safe to read without a null check.
final class OperatorDashboardSummary {
  const OperatorDashboardSummary({
    required this.activeTotal,
    required this.byStatus,
    required this.deliveredToday,
    required this.returnPending,
  });
  final int activeTotal, deliveredToday, returnPending;
  final Map<String, int> byStatus;

  int statusCount(String status) => byStatus[status] ?? 0;

  /// Kept separate from `ApiOperatorRepository` so the response-shape
  /// contract is unit-testable without a real or faked network call —
  /// missing/malformed required fields fail loud, matching the same
  /// "never silently default" rule the rest of the mobile DTO layer follows.
  factory OperatorDashboardSummary.fromJson(Map<String, dynamic> value) {
    final byStatusRaw = value['byStatus'];
    if (byStatusRaw is! Map) {
      throw const OperatorDashboardParseError('missing_field_byStatus');
    }
    final activeTotal = value['activeTotal'];
    final deliveredToday = value['deliveredToday'];
    final returnPending = value['returnPending'];
    if (activeTotal is! int) {
      throw const OperatorDashboardParseError('invalid_field_activeTotal');
    }
    if (deliveredToday is! int) {
      throw const OperatorDashboardParseError('invalid_field_deliveredToday');
    }
    if (returnPending is! int) {
      throw const OperatorDashboardParseError('invalid_field_returnPending');
    }
    return OperatorDashboardSummary(
      activeTotal: activeTotal,
      byStatus: {
        for (final entry in byStatusRaw.entries)
          entry.key.toString(): entry.value is int ? entry.value as int : 0,
      },
      deliveredToday: deliveredToday,
      returnPending: returnPending,
    );
  }
}

final class OperatorDashboardParseError implements Exception {
  const OperatorDashboardParseError(this.code);
  final String code;
}

/// One Operator dashboard card: a title, the server-reported count backing
/// it, and the exact `/orders` deep link tapping it should open. Kept as
/// plain data (no widget/BuildContext) so the summary → card → route mapping
/// is unit-testable on its own, without pumping a widget tree.
final class OperatorDashboardCard {
  const OperatorDashboardCard({
    required this.title,
    required this.value,
    required this.route,
  });
  final String title;
  final int value;
  final String route;
}

/// The approved 4–6 card set for the Operator dashboard, in display order.
/// `l10n` supplies only display strings; every count and route decision is
/// deterministic from `summary` alone — that mapping is what the permanent
/// test suite exercises directly, without pumping a widget tree.
List<OperatorDashboardCard> operatorDashboardCards(
  OperatorDashboardSummary summary,
  AppLocalizations l10n,
) => [
  OperatorDashboardCard(
    title: l10n.totalActiveOrders,
    value: summary.activeTotal,
    route: '/orders',
  ),
  OperatorDashboardCard(
    title: l10n.newStatus,
    value: summary.statusCount('new'),
    route: '/orders?deliveryStatus=new',
  ),
  OperatorDashboardCard(
    title: l10n.assignedToDriver,
    value: summary.statusCount('assigned_to_driver'),
    route: '/orders?deliveryStatus=assigned_to_driver',
  ),
  OperatorDashboardCard(
    title: l10n.outForDelivery,
    value: summary.statusCount('out_for_delivery'),
    route: '/orders?deliveryStatus=out_for_delivery',
  ),
  OperatorDashboardCard(
    title: l10n.deliveredToday,
    value: summary.deliveredToday,
    route: '/orders?deliveryStatus=delivered',
  ),
  OperatorDashboardCard(
    title: l10n.returnPending,
    value: summary.returnPending,
    route: '/orders?deliveryStatus=returned_to_branch',
  ),
];

/// Reshapes a (server-narrowed, for a Driver User) `OperatorDashboardSummary`
/// into the same shape `driverDashboardCards` already renders for a genuine
/// `driver`-kind account — so the Driver-style 5-card dashboard layout has
/// exactly one card-mapping implementation, never a second one duplicated
/// for the Driver User path. Deliberately reads only `summary` — the widget
/// never itself recomputes or leaks a company-wide total; whatever narrowing
/// the server already applied (`operatorDashboardSummary()` for a Driver
/// User) is exactly what ends up on screen.
DriverDashboardSummary driverPresentationSummaryFromOperator(
  OperatorDashboardSummary summary,
) => DriverDashboardSummary(
  activeTotal: summary.activeTotal,
  assignedToMe: summary.statusCount('assigned_to_driver'),
  outForDelivery: summary.statusCount('out_for_delivery'),
  deliveredToday: summary.deliveredToday,
  returnPending: summary.returnPending,
);

/// Mirrors the server's `operationsTransitions` map for a `company_user`
/// identity (`operations.service.ts`, `changeOrderStatus`) — the backend
/// re-validates every transition independently, so this exists purely to
/// avoid showing the Operator a button that would only fail server-side.
const Map<String, List<String>> _serverDeliveryStatusTransitions = {
  'new': ['in_branch', 'hold', 'cancelled'],
  'in_branch': ['cancelled'],
  'assigned_to_driver': ['out_for_delivery', 'hold', 'cancelled'],
  'out_for_delivery': ['hold', 'delivered', 'returned_to_branch', 'cancelled'],
  'hold': ['out_for_delivery', 'delivered', 'returned_to_trader', 'cancelled'],
  'delivered': ['closed'],
  'returned_to_branch': ['returned_to_trader'],
  'returned_to_trader': ['closed'],
};

/// The approved user-facing status model (New, Assigned to Driver, Out for
/// Delivery, Delivered, Returned to Branch, Returned to Trader, Cancelled).
/// `hold`/`in_branch`/`closed` are real backend states but are internal —
/// never offered as a tappable target on the Operator status-action list.
/// Moving a New Order into Assigned to Driver happens exclusively through
/// the Assign Driver action, not a status button, matching how the backend
/// only reaches `assigned_to_driver` as an assignment side effect.
const Set<String> operatorSelectableStatusTargetsAllowlist = {
  'out_for_delivery',
  'delivered',
  'returned_to_branch',
  'returned_to_trader',
  'cancelled',
};

/// A reason is mandatory server-side for these targets
/// (`order_status_reason_required`).
const Set<String> operatorStatusChangeReasonRequired = {
  'cancelled',
  'returned_to_branch',
  'returned_to_trader',
};

List<String> operatorSelectableStatusTargets(String currentStatus) => [
  for (final target
      in _serverDeliveryStatusTransitions[currentStatus] ?? const [])
    if (operatorSelectableStatusTargetsAllowlist.contains(target)) target,
];

/// A fresh assignment is only offered while the Order has no Driver yet and
/// is still New/In-Branch/Hold — the same states `bulkAssignDriver` accepts.
bool operatorCanAssignDriver(String status, String? driverId) =>
    driverId == null && {'new', 'in_branch', 'hold'}.contains(status);

/// Reassignment is only offered once a Driver is attached and the Order has
/// not yet gone Out for Delivery — matching the server's
/// `assignmentIneligibilityReason` for an already-assigned Order.
bool operatorCanReassignDriver(String status, String? driverId) =>
    driverId != null && {'assigned_to_driver', 'hold'}.contains(status);
