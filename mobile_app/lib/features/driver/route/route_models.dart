/// Driver route planning models (`GET/POST portal/driver/route…`).
///
/// Parsing is deliberately lenient: an optional field that is missing or of
/// an unexpected type becomes `null` or a safe default instead of failing the
/// whole route. Only the identifiers the screen cannot work without are
/// required. (A strict parser that rejected the whole list on one odd field
/// is exactly what broke the Trader Orders list.)
library;

String? _string(Object? value) => value is String && value.isNotEmpty ? value : null;

int _int(Object? value, [int fallback = 0]) => switch (value) {
  final int number => number,
  final num number => number.toInt(),
  final String text => int.tryParse(text) ?? fallback,
  _ => fallback,
};

int? _intOrNull(Object? value) => value == null ? null : _int(value);

double? _double(Object? value) => switch (value) {
  final num number => number.toDouble(),
  final String text => double.tryParse(text),
  _ => null,
};

bool _bool(Object? value) => value == true;

List<Map<String, dynamic>> _maps(Object? value) => value is List
    ? [for (final item in value) if (item is Map) Map<String, dynamic>.from(item)]
    : const [];

final class RouteOrder {
  const RouteOrder({
    required this.id,
    required this.orderNumber,
    this.serialNumber,
    this.referenceNumber,
    this.customerName,
    this.deliveryStatus,
    this.areaId,
  });

  factory RouteOrder.fromJson(Map<String, dynamic> json) => RouteOrder(
    id: _string(json['id']) ?? '',
    orderNumber: _string(json['orderNumber']) ?? '',
    serialNumber: _string(json['serialNumber']),
    referenceNumber: _string(json['referenceNumber']),
    customerName: _string(json['customerName']),
    deliveryStatus: _string(json['deliveryStatus']),
    areaId: _string(json['areaId']),
  );

  final String id;
  final String orderNumber;
  final String? serialNumber, referenceNumber, customerName, deliveryStatus, areaId;

  Map<String, dynamic> toJson() => {
    'id': id,
    'orderNumber': orderNumber,
    'serialNumber': serialNumber,
    'referenceNumber': referenceNumber,
    'customerName': customerName,
    'deliveryStatus': deliveryStatus,
    'areaId': areaId,
  };
}

final class RouteArea {
  const RouteArea({
    required this.areaId,
    required this.areaNameEn,
    this.areaNameAr,
    required this.emirateNameEn,
    this.emirateNameAr,
    this.sequencePosition,
    required this.isSequenced,
    required this.isNew,
    required this.status,
    required this.orderCount,
    required this.cashHandoverCount,
    this.latitude,
    this.longitude,
    required this.orders,
  });

  factory RouteArea.fromJson(Map<String, dynamic> json) => RouteArea(
    areaId: _string(json['areaId']) ?? '',
    areaNameEn: _string(json['areaNameEn']) ?? '',
    areaNameAr: _string(json['areaNameAr']),
    emirateNameEn: _string(json['emirateNameEn']) ?? '',
    emirateNameAr: _string(json['emirateNameAr']),
    sequencePosition: _intOrNull(json['sequencePosition']),
    isSequenced: _bool(json['isSequenced']),
    isNew: _bool(json['isNew']),
    status: _string(json['status']) ?? 'pending',
    orderCount: _int(json['orderCount']),
    cashHandoverCount: _int(json['cashHandoverCount']),
    latitude: _double(json['latitude']),
    longitude: _double(json['longitude']),
    orders: [for (final item in _maps(json['orders'])) RouteOrder.fromJson(item)],
  );

  final String areaId, areaNameEn, emirateNameEn, status;
  final String? areaNameAr, emirateNameAr;
  final int? sequencePosition;
  final bool isSequenced, isNew;
  final int orderCount, cashHandoverCount;
  final double? latitude, longitude;
  final List<RouteOrder> orders;

  bool get isDone => status == 'done';
  bool get hasPin => latitude != null && longitude != null;

  String areaName(String locale) => locale == 'ar' ? (areaNameAr ?? areaNameEn) : areaNameEn;
  String emirateName(String locale) => locale == 'ar' ? (emirateNameAr ?? emirateNameEn) : emirateNameEn;

  Map<String, dynamic> toJson() => {
    'areaId': areaId,
    'areaNameEn': areaNameEn,
    'areaNameAr': areaNameAr,
    'emirateNameEn': emirateNameEn,
    'emirateNameAr': emirateNameAr,
    'sequencePosition': sequencePosition,
    'isSequenced': isSequenced,
    'isNew': isNew,
    'status': status,
    'orderCount': orderCount,
    'cashHandoverCount': cashHandoverCount,
    'latitude': latitude,
    'longitude': longitude,
    'orders': [for (final order in orders) order.toJson()],
  };
}

final class RouteRun {
  const RouteRun({
    required this.id,
    required this.referenceNumber,
    required this.businessDate,
    required this.revision,
    required this.direction,
    required this.resultSource,
    this.fallbackReason,
    required this.partialOptimization,
    this.distanceMeters,
    this.durationSeconds,
    required this.areas,
    required this.deferredOrders,
    this.nextAreaId,
    required this.cashHandoverOrderCount,
  });

  factory RouteRun.fromJson(Map<String, dynamic> json) => RouteRun(
    id: _string(json['id']) ?? '',
    referenceNumber: _string(json['referenceNumber']) ?? '',
    businessDate: _string(json['businessDate']) ?? '',
    revision: _int(json['revision'], 1),
    direction: _string(json['direction']) ?? 'recommended',
    resultSource: _string(json['resultSource']) ?? 'fallback',
    fallbackReason: _string(json['fallbackReason']),
    partialOptimization: _bool(json['partialOptimization']),
    distanceMeters: _intOrNull(json['distanceMeters']),
    durationSeconds: _intOrNull(json['durationSeconds']),
    areas: [for (final item in _maps(json['areas'])) RouteArea.fromJson(item)],
    deferredOrders: [for (final item in _maps(json['deferredOrders'])) RouteOrder.fromJson(item)],
    nextAreaId: _string(json['nextAreaId']),
    cashHandoverOrderCount: _int(json['cashHandoverOrderCount']),
  );

  final String id, referenceNumber, businessDate, direction, resultSource;
  final String? fallbackReason, nextAreaId;
  final int revision, cashHandoverOrderCount;
  final bool partialOptimization;
  final int? distanceMeters, durationSeconds;
  final List<RouteArea> areas;
  final List<RouteOrder> deferredOrders;

  bool get isFallback => resultSource != 'provider';
  RouteArea? get nextArea {
    for (final area in areas) {
      if (area.areaId == nextAreaId) return area;
    }
    return null;
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'referenceNumber': referenceNumber,
    'businessDate': businessDate,
    'revision': revision,
    'direction': direction,
    'resultSource': resultSource,
    'fallbackReason': fallbackReason,
    'partialOptimization': partialOptimization,
    'distanceMeters': distanceMeters,
    'durationSeconds': durationSeconds,
    'areas': [for (final area in areas) area.toJson()],
    'deferredOrders': [for (final order in deferredOrders) order.toJson()],
    'nextAreaId': nextAreaId,
    'cashHandoverOrderCount': cashHandoverOrderCount,
  };
}

/// What the Route tab shows. `offline` marks a saved copy served because the
/// server could not be reached; actions are disabled while it is set.
final class RouteState {
  const RouteState({required this.enabled, this.run, this.stale = false, this.offline = false});

  factory RouteState.fromJson(Map<String, dynamic> json, {bool offline = false}) => RouteState(
    enabled: _bool(json['enabled']),
    stale: _bool(json['stale']),
    offline: offline,
    run: json['run'] is Map ? RouteRun.fromJson(Map<String, dynamic>.from(json['run'] as Map)) : null,
  );

  final bool enabled, stale, offline;
  final RouteRun? run;

  Map<String, dynamic> toJson() => {'enabled': enabled, 'stale': false, 'run': run?.toJson()};
}
