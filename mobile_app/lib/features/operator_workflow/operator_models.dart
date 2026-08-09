final class OperatorOrder {
  const OperatorOrder({
    required this.id,
    required this.orderNumber,
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
  });
  final String id,
      orderNumber,
      orderDate,
      traderName,
      customerName,
      customerMobile,
      address,
      areaName,
      cod,
      status;
  final String? reference, driverId, driverName, notes;
  final List<OperatorOrderEvent> history;
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
  'reconciliations.create',
  'reconciliations.reverse',
  'settlements.create',
  'settlements.reverse',
  'users_roles.manage',
};
