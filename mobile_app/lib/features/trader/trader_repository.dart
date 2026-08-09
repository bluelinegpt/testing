import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/validation/safe_parsers.dart';
import 'package:bluelinegpt_mobile/features/trader/trader_models.dart';

abstract interface class TraderRepository {
  Future<List<TraderArea>> areas();
  Future<List<TraderOrder>> orders();
  Future<TraderPricingPreview> previewPricing(TraderOrderDraft draft);
  Future<TraderOrder> create(
    TraderOrderDraft draft,
    TraderPricingPreview preview,
    String idempotencyKey,
  );
}

final class ApiTraderRepository implements TraderRepository {
  ApiTraderRepository(this.api);
  final ApiClient api;

  @override
  Future<List<TraderArea>> areas() async {
    final data = (await api.get<Object?>('portal/trader/areas')).data;
    if (data is! List) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return data
        .map((item) {
          final value = Map<String, dynamic>.from(item as Map);
          return TraderArea(
            id: _required(value, 'id'),
            emirateId: _required(value, 'emirateId'),
            nameEn: _required(value, 'nameEn'),
            nameAr: value['nameAr'] as String?,
            emirateNameEn: _required(value, 'emirateNameEn'),
            emirateNameAr: value['emirateNameAr'] as String?,
          );
        })
        .toList(growable: false);
  }

  @override
  Future<List<TraderOrder>> orders() async {
    final data = (await api.get<Object?>('portal/trader/orders')).data;
    if (data is! List) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    final seen = <String>{};
    return [
      for (final item in data)
        if (item is Map && seen.add(item['id']?.toString() ?? ''))
          _order(Map<String, dynamic>.from(item)),
    ];
  }

  @override
  Future<TraderPricingPreview> previewPricing(TraderOrderDraft draft) =>
      Future.error(
        UnsupportedError('Trader-scoped pricing preview is unavailable'),
      );

  @override
  Future<TraderOrder> create(
    TraderOrderDraft draft,
    TraderPricingPreview preview,
    String idempotencyKey,
  ) async {
    final amount = SafeNumberParser.parse(draft.cod).value;
    if (draft.validate().isNotEmpty || amount == null) {
      throw const ApiFailure(ApiFailureKind.validation);
    }
    final serialData = (await api.get<Object?>(
      'operations/orders/next-serial-number',
    )).data;
    if (serialData is! Map || serialData['serialNumber'] is! String) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    final response = await api.postWithHeaders<Object?>(
      'portal/trader/orders',
      headers: {'X-Idempotency-Key': idempotencyKey},
      data: {
        'serialNumber': serialData['serialNumber'],
        if (draft.normalizedReference != null)
          'referenceNumber': draft.normalizedReference,
        'areaId': draft.areaId,
        'customerName': draft.customerName.trim(),
        'customerMobileNumber': UaeMobileValidator.normalize(
          draft.customerMobile,
        ),
        'customerAddress': draft.address.trim(),
        'codAmount': amount,
        'notes': draft.notes?.trim(),
      },
    );
    if (response.data is! Map) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    final value = Map<String, dynamic>.from(response.data! as Map);
    return TraderOrder(
      id: _required(value, 'id'),
      orderNumber: _required(value, 'orderNumber'),
      orderDate: _required(value, 'orderDate'),
      areaId: draft.areaId,
      areaName: value['areaName']?.toString() ?? '',
      customerName: draft.customerName.trim(),
      customerMobile: UaeMobileValidator.normalize(draft.customerMobile),
      address: draft.address.trim(),
      cod: value['codAmount']?.toString() ?? preview.cod,
      serviceFee: value['serviceFee']?.toString() ?? preview.deliveryFee,
      netExpected: value['traderNetPayable']?.toString() ?? preview.netExpected,
      status: value['deliveryStatus']?.toString() ?? 'new',
      reference: draft.normalizedReference,
      notes: draft.notes?.trim(),
    );
  }

  static TraderOrder _order(Map<String, dynamic> value) => TraderOrder(
    id: _required(value, 'id'),
    orderNumber: _required(value, 'orderNumber'),
    orderDate: _required(value, 'orderDate'),
    areaId: _required(value, 'areaId'),
    areaName: _required(value, 'areaName'),
    customerName: _required(value, 'customerName'),
    customerMobile: _required(value, 'customerMobileNumber'),
    address: _required(value, 'customerAddress'),
    cod: _required(value, 'codAmount'),
    serviceFee: _required(value, 'serviceFee'),
    netExpected: null,
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
