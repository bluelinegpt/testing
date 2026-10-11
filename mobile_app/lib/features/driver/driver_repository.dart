import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';

abstract interface class DriverRepository {
  Future<List<DriverOrder>> orders();
  Future<DriverDashboardSummary> dashboardSummary();
  Future<List<DriverOrderHistoryEvent>> history(String orderId);

  /// Generalized status transition covering every reachable Driver action —
  /// Start Delivery (`out_for_delivery`), Delivered (`delivered`), and Return
  /// to Branch (`returned_to_branch`, which requires `reason`). Mirrors the
  /// backend's `{status, reason?, expectedStatus?}` body shape exactly
  /// (`operations.controller.ts` `changeDriverOrderStatus`).
  ///
  /// `expectedStatus` (Prompt 16) is the delivery status the caller last
  /// knew to be current — normally the cached Order's `status` read just
  /// before the call. Optional; omitting it preserves the exact pre-Prompt
  /// 16 behavior.
  Future<DriverOrder> changeStatus(
    String orderId,
    String status,
    String idempotencyKey, {
    String? reason,
    String? expectedStatus,
  });
}

final class ApiDriverRepository implements DriverRepository {
  ApiDriverRepository(this.api);
  final ApiClient api;

  @override
  Future<List<DriverOrder>> orders() async {
    final data = (await api.get<Object?>('portal/driver/orders')).data;
    if (data is! List) throw const ApiFailure(ApiFailureKind.invalidResponse);
    final seen = <String>{};
    return [
      for (final item in data)
        if (item is Map && seen.add(item['id']?.toString() ?? ''))
          _order(Map<String, dynamic>.from(item)),
    ];
  }

  @override
  Future<DriverDashboardSummary> dashboardSummary() async {
    final data = (await api.get<Object?>(
      'portal/driver/dashboard-summary',
    )).data;
    if (data is! Map) throw const ApiFailure(ApiFailureKind.invalidResponse);
    return DriverDashboardSummary.fromJson(Map<String, dynamic>.from(data));
  }

  @override
  Future<List<DriverOrderHistoryEvent>> history(String orderId) async {
    final data = (await api.get<Object?>(
      'portal/driver/orders/$orderId/history',
    )).data;
    if (data is! List) throw const ApiFailure(ApiFailureKind.invalidResponse);
    return [
      for (final item in data)
        if (item is Map) _historyEvent(Map<String, dynamic>.from(item)),
    ];
  }

  @override
  Future<DriverOrder> changeStatus(
    String orderId,
    String status,
    String idempotencyKey, {
    String? reason,
    String? expectedStatus,
  }) async {
    final response = await api.patchWithHeaders<Object?>(
      'portal/driver/orders/$orderId/status',
      headers: {'X-Idempotency-Key': idempotencyKey},
      data: {
        // An action queued offline by an older build may still carry
        // `returned_to_branch`; the API only accepts `in_branch` for it.
        'status': status == 'returned_to_branch' ? 'in_branch' : status,
        'reason': ?reason,
        'expectedStatus': ?expectedStatus,
      },
    );
    if (response.data is! Map) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return _order(Map<String, dynamic>.from(response.data! as Map));
  }

  /// Only what identifies the Order is required. A display field that is
  /// empty (an Order saved without a customer name or address, which Fast
  /// Entry allows) falls back instead of failing the Driver's whole list.
  static DriverOrder _order(Map<String, dynamic> value) => DriverOrder(
    id: _required(value, 'id'),
    orderNumber: _required(value, 'orderNumber'),
    serialNumber: _text(value, 'serialNumber'),
    psystemSerial: value['psystemSerial'] as String?,
    orderDate: _text(value, 'orderDate'),
    areaId: _text(value, 'areaId'),
    areaName: _text(value, 'areaName'),
    customerName: _text(value, 'customerName'),
    customerMobile: _text(value, 'customerMobileNumber'),
    address: _text(value, 'customerAddress'),
    expectedCod: _text(value, 'customerAmountDue', fallback: '0.00'),
    amountCollected: _text(value, 'amountCollected', fallback: '0.00'),
    status: _required(value, 'deliveryStatus'),
    driverReconciliationStatus: value['driverReconciliationStatus'] as String?,
    traderName: _text(value, 'traderName'),
    reference: value['referenceNumber'] as String?,
    notes: value['notes'] as String?,
    emirateNameEn: value['emirateNameEn'] as String?,
    emirateNameAr: value['emirateNameAr'] as String?,
  );

  static DriverOrderHistoryEvent _historyEvent(Map<String, dynamic> value) =>
      DriverOrderHistoryEvent(
        toStatus: _required(value, 'toStatus'),
        occurredAt: _required(value, 'occurredAt'),
        fromStatus: value['fromStatus'] as String?,
      );

  static String _text(
    Map<String, dynamic> value,
    String key, {
    String fallback = '',
  }) {
    final result = value[key];
    return result is String && result.isNotEmpty ? result : fallback;
  }

  static String _required(Map<String, dynamic> value, String key) {
    final result = value[key];
    if (result is! String || result.isEmpty) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return result;
  }
}
