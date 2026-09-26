import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/customer/customer_models.dart';

abstract interface class CustomerRepository {
  Future<CustomerTrackingSummary> tracking(String token);
}

final class ApiCustomerRepository implements CustomerRepository {
  ApiCustomerRepository(this.api);
  final ApiClient api;
  @override
  Future<CustomerTrackingSummary> tracking(String token) async {
    if (!isValidTrackingToken(token)) {
      throw const ApiFailure(ApiFailureKind.validation);
    }
    final data = (await api.get<Object?>('public/tracking/$token')).data;
    if (data is! Map) throw const ApiFailure(ApiFailureKind.invalidResponse);
    return CustomerTrackingSummary(
      companyName: _required(data, 'companyName'),
      orderNumber: _required(data, 'orderNumber'),
      customerName: _required(data, 'customerName'),
      areaName: _required(data, 'areaName'),
      status: customerStatus(_required(data, 'deliveryStatus')),
      lastUpdatedAt: _required(data, 'lastUpdatedAt'),
      deliveredAt: data['deliveredAt'] as String?,
    );
  }

  static String _required(Map value, String key) {
    final result = value[key];
    if (result is! String || result.isEmpty) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return result;
  }
}
