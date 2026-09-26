enum CustomerOrderStatus {
  received,
  assigned,
  outForDelivery,
  delivered,
  deliveryIssue,
  returnedToBranch,
  returnedToTrader,
  cancelled,
  updating,
}

CustomerOrderStatus customerStatus(String value) => switch (value) {
  'new' || 'in_branch' => CustomerOrderStatus.received,
  'assigned' || 'assigned_to_driver' => CustomerOrderStatus.assigned,
  'out_for_delivery' => CustomerOrderStatus.outForDelivery,
  'delivered' => CustomerOrderStatus.delivered,
  'hold' => CustomerOrderStatus.deliveryIssue,
  'returned_to_branch' => CustomerOrderStatus.returnedToBranch,
  'returned_to_trader' => CustomerOrderStatus.returnedToTrader,
  'cancelled' => CustomerOrderStatus.cancelled,
  _ => CustomerOrderStatus.updating,
};

final class CustomerTrackingSummary {
  const CustomerTrackingSummary({
    required this.companyName,
    required this.orderNumber,
    required this.customerName,
    required this.areaName,
    required this.status,
    required this.lastUpdatedAt,
    this.deliveredAt,
  });
  final String companyName, orderNumber, customerName, areaName, lastUpdatedAt;
  final CustomerOrderStatus status;
  final String? deliveredAt;
}

bool isValidTrackingToken(String token) =>
    RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(token);
