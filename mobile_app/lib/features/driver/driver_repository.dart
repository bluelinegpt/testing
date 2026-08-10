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
        'status': status,
        'reason': ?reason,
        'expectedStatus': ?expectedStatus,
      },
    );
    if (response.data is! Map) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return _order(Map<String, dynamic>.from(response.data! as Map));
  }

  static DriverOrder _order(Map<String, dynamic> value) => DriverOrder(
    id: _required(value, 'id'),
    orderNumber: _required(value, 'orderNumber'),
    serialNumber: _required(value, 'serialNumber'),
    orderDate: _required(value, 'orderDate'),
    areaId: _required(value, 'areaId'),
    areaName: _required(value, 'areaName'),
    customerName: _required(value, 'customerName'),
    customerMobile: _required(value, 'customerMobileNumber'),
    address: _required(value, 'customerAddress'),
    expectedCod: _required(value, 'customerAmountDue'),
    amountCollected: _required(value, 'amountCollected'),
    status: _required(value, 'deliveryStatus'),
    traderName: _required(value, 'traderName'),
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

  static String _required(Map<String, dynamic> value, String key) {
    final result = value[key];
    if (result is! String || result.isEmpty) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return result;
  }
}
