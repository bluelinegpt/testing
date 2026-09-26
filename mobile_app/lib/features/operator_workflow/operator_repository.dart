import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_models.dart';

abstract interface class OperatorRepository {
  Future<OperatorDashboardSummary> dashboardSummary();
  Future<OperatorOrderPage> orders({
    int page = 1,
    String? search,
    String? status,
  });
  Future<OperatorOrder> detail(String id);
  Future<List<OperatorDriver>> drivers();
  Future<void> assign(String orderId, String driverId);
  Future<void> changeStatus(String orderId, String status, {String? reason});
}

final class ApiOperatorRepository implements OperatorRepository {
  ApiOperatorRepository(this.api);
  final ApiClient api;

  @override
  Future<OperatorDashboardSummary> dashboardSummary() async {
    final data = (await api.get<Object?>(
      'operations/orders/dashboard-summary',
    )).data;
    if (data is! Map) throw const ApiFailure(ApiFailureKind.invalidResponse);
    try {
      return OperatorDashboardSummary.fromJson(Map<String, dynamic>.from(data));
    } on OperatorDashboardParseError catch (error) {
      throw ApiFailure(ApiFailureKind.invalidResponse, code: error.code);
    }
  }

  @override
  Future<OperatorOrderPage> orders({
    int page = 1,
    String? search,
    String? status,
  }) async {
    final query = <String, dynamic>{
      'page': page,
      'pageSize': 25,
      'quickView': 'active',
      'sortBy': 'createdAt',
      'sortDirection': 'desc',
    };
    if (search?.trim().isNotEmpty == true) query['search'] = search!.trim();
    if (status != null) query['deliveryStatus'] = status;
    final response = await api.getWithQuery<Object?>(
      'operations/orders',
      queryParameters: query,
    );
    final data = response.data;
    if (data is! Map || data['items'] is! List) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    final seen = <String>{};
    return OperatorOrderPage(
      items: [
        for (final item in data['items'] as List)
          if (item is Map && seen.add(item['id']?.toString() ?? ''))
            _order(Map<String, dynamic>.from(item)),
      ],
      page: _integer(data, 'page'),
      pageSize: _integer(data, 'pageSize'),
      totalCount: _integer(data, 'totalCount'),
    );
  }

  @override
  Future<OperatorOrder> detail(String id) async {
    final data = (await api.get<Object?>('operations/orders/$id')).data;
    if (data is! Map) throw const ApiFailure(ApiFailureKind.invalidResponse);
    return _order(Map<String, dynamic>.from(data), includeHistory: true);
  }

  @override
  Future<List<OperatorDriver>> drivers() async {
    final data = (await api.get<Object?>('operations/drivers')).data;
    if (data is! List) throw const ApiFailure(ApiFailureKind.invalidResponse);
    return [
      for (final item in data)
        if (item is Map)
          OperatorDriver(
            id: _required(item, 'id'),
            name: _required(item, 'name'),
            status: _required(item, 'status'),
            type: _required(item, 'type'),
            activeOrders: _integer(item, 'activeOrders'),
          ),
    ];
  }

  @override
  Future<void> assign(String orderId, String driverId) async {
    final payload = {
      'selectionMode': 'ids',
      'orderIds': [orderId],
      'driverIdToAssign': driverId,
    };
    await api.post<Object?>(
      'operations/orders/bulk-assign/preview',
      data: payload,
    );
    await api.post<Object?>('operations/orders/bulk-assign', data: payload);
  }

  @override
  Future<void> changeStatus(
    String orderId,
    String status, {
    String? reason,
  }) async {
    final payload = <String, dynamic>{'status': status};
    final trimmedReason = reason?.trim();
    if (trimmedReason?.isNotEmpty == true) payload['reason'] = trimmedReason;
    await api.patch<Object?>(
      'operations/orders/$orderId/status',
      data: payload,
    );
  }

  static OperatorOrder _order(
    Map<String, dynamic> value, {
    bool includeHistory = false,
  }) => OperatorOrder(
    id: _required(value, 'id'),
    orderNumber: _required(value, 'orderNumber'),
    serialNumber: _required(value, 'serialNumber'),
    psystemSerial: value['psystemSerial'] as String?,
    orderDate: _required(value, 'orderDate'),
    traderName: _required(value, 'traderName'),
    customerName: _required(value, 'customerName'),
    customerMobile: _required(value, 'customerMobileNumber'),
    // Existing/legacy Orders can lack a captured address. That must not hide
    // the entire Company order list; detail and editing flows remain server
    // authoritative for correcting the Order record.
    address: _optionalText(value, 'customerAddress'),
    areaName: _required(value, 'areaName'),
    cod: _required(value, 'customerAmountDue'),
    status: _required(value, 'deliveryStatus'),
    reference: value['referenceNumber'] as String?,
    driverId: value['assignedDriverId'] as String?,
    driverName: value['assignedDriverName'] as String?,
    notes: value['metadata'] is Map
        ? (value['metadata'] as Map)['notes'] as String?
        : null,
    // Present only on the single-Order detail fetch — the list query has no
    // `emirates` join server-side (`operations.service.ts`'s `orders()` vs
    // `orderById()`), so these are simply absent (never fabricated) there.
    emirateNameEn: value['emirateNameEn'] as String?,
    emirateNameAr: value['emirateNameAr'] as String?,
    history: includeHistory && value['history'] is List
        ? [
            for (final event in value['history'] as List)
              if (event is Map)
                OperatorOrderEvent(
                  status: _required(event, 'toStatus'),
                  occurredAt: _required(event, 'occurredAt'),
                  fromStatus: event['fromStatus'] as String?,
                  reason: event['reason'] as String?,
                  actor: event['changedBy'] as String?,
                ),
          ]
        : const [],
  );
  static String _required(Map value, String key) {
    final result = value[key];
    if (result is! String || result.isEmpty) {
      throw ApiFailure(
        ApiFailureKind.invalidResponse,
        code: 'missing_field_$key',
      );
    }
    return result;
  }

  static int _integer(Map value, String key) {
    final result = value[key];
    if (result is! int) {
      throw ApiFailure(
        ApiFailureKind.invalidResponse,
        code: 'invalid_field_$key',
      );
    }
    return result;
  }

  static String _optionalText(Map value, String key) {
    final result = value[key];
    return result is String ? result : '';
  }
}
