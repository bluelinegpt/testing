import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';

abstract interface class DriverRepository {
  Future<List<DriverOrder>> orders();
  Future<DriverOrder> startDelivery(String orderId, String idempotencyKey);
  Future<DriverOrder> confirmDelivery(
    String orderId,
    DeliveryConfirmationDraft draft,
    String idempotencyKey,
  );
  Future<DriverOrder> reportFailure(
    String orderId,
    String reason,
    String? notes,
  );
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
  Future<DriverOrder> startDelivery(String orderId, String idempotencyKey) =>
      _transition(orderId, 'out_for_delivery', idempotencyKey);
  @override
  Future<DriverOrder> confirmDelivery(
    String orderId,
    DeliveryConfirmationDraft draft,
    String idempotencyKey,
  ) => Future.error(
    UnsupportedError('Driver payment collection contract is unavailable'),
  );
  @override
  Future<DriverOrder> reportFailure(
    String orderId,
    String reason,
    String? notes,
  ) => Future.error(
    UnsupportedError('Delivery attempt contract is unavailable'),
  );

  Future<DriverOrder> _transition(
    String orderId,
    String status,
    String idempotencyKey,
  ) async {
    final response = await api.patchWithHeaders<Object?>(
      'portal/driver/orders/$orderId/status',
      headers: {'X-Idempotency-Key': idempotencyKey},
      data: {'status': status},
    );
    if (response.data is! Map) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return _order(Map<String, dynamic>.from(response.data! as Map));
  }

  static DriverOrder _order(Map<String, dynamic> value) => DriverOrder(
    id: _required(value, 'id'),
    orderNumber: _required(value, 'orderNumber'),
    orderDate: _required(value, 'orderDate'),
    areaId: _required(value, 'areaId'),
    areaName: _required(value, 'areaName'),
    customerName: _required(value, 'customerName'),
    customerMobile: _required(value, 'customerMobileNumber'),
    address: _required(value, 'customerAddress'),
    expectedCod: _required(value, 'customerAmountDue'),
    amountCollected: _required(value, 'amountCollected'),
    status: _required(value, 'deliveryStatus'),
    reference: value['referenceNumber'] as String?,
    notes: value['notes'] as String?,
  );
  static String _required(Map<String, dynamic> value, String key) {
    final result = value[key];
    if (result is! String || result.isEmpty) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return result;
  }
}
