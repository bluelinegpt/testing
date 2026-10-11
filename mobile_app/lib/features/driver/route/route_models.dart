/// Driver route planning models (`GET/POST portal/driver/route…`).
///
/// Parsing is deliberately lenient: an optional field that is missing or of
/// an unexpected type becomes `null` or a safe default instead of failing the
/// whole route. Only the identifiers the screen cannot work without are
/// required. (A strict parser that rejected the whole list on one odd field
/// is exactly what broke the Trader Orders list.)
library;

String? _string(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

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
    ? [
        for (final item in value)
          if (item is Map) Map<String, dynamic>.from(item),
      ]
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
    this.customerMobile,
    this.customerAddress,
    this.amountDue,
    this.noAnswerCount = 0,
  });

  factory RouteOrder.fromJson(Map<String, dynamic> json) => RouteOrder(
    id: _string(json['id']) ?? '',
    orderNumber: _string(json['orderNumber']) ?? '',
    serialNumber: _string(json['serialNumber']),
    referenceNumber: _string(json['referenceNumber']),
    customerName: _string(json['customerName']),
    deliveryStatus: _string(json['deliveryStatus']),
    areaId: _string(json['areaId']),
    customerMobile: _string(json['customerMobile']),
    customerAddress: _string(json['customerAddress']),
    amountDue: _string(json['amountDue']),
    noAnswerCount: _int(json['noAnswerCount']),
  );

  final String id;
  final String orderNumber;
  final String? serialNumber,
      referenceNumber,
      customerName,
      deliveryStatus,
      areaId,
      customerMobile,
      customerAddress,
      amountDue;

  /// Times the Driver recorded "no answer" today. The Order is unchanged.
  final int noAnswerCount;

  /// Reference number when there is one, otherwise the serial number.
  String get label => (referenceNumber?.trim().isNotEmpty ?? false)
      ? referenceNumber!.trim()
      : (serialNumber ?? orderNumber);

  Map<String, dynamic> toJson() => {
    'id': id,
    'orderNumber': orderNumber,
    'serialNumber': serialNumber,
    'referenceNumber': referenceNumber,
    'customerName': customerName,
    'deliveryStatus': deliveryStatus,
    'areaId': areaId,
    'customerMobile': customerMobile,
    'customerAddress': customerAddress,
    'amountDue': amountDue,
    'noAnswerCount': noAnswerCount,
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
    orders: [
      for (final item in _maps(json['orders'])) RouteOrder.fromJson(item),
    ],
  );

  final String areaId, areaNameEn, emirateNameEn, status;
  final String? areaNameAr, emirateNameAr;
  final int? sequencePosition;
  final bool isSequenced, isNew;
  final int orderCount, cashHandoverCount;
  final double? latitude, longitude;
  final List<RouteOrder> orders;

  bool get isDone => status == 'done';

  /// The same Area with its Orders in a new order.
  RouteArea withOrders(List<RouteOrder> reordered) => RouteArea(
    areaId: areaId,
    areaNameEn: areaNameEn,
    areaNameAr: areaNameAr,
    emirateNameEn: emirateNameEn,
    emirateNameAr: emirateNameAr,
    sequencePosition: sequencePosition,
    isSequenced: isSequenced,
    isNew: isNew,
    status: status,
    orderCount: orderCount,
    cashHandoverCount: cashHandoverCount,
    latitude: latitude,
    longitude: longitude,
    orders: reordered,
  );
  bool get hasPin => latitude != null && longitude != null;

  String areaName(String locale) =>
      locale == 'ar' ? (areaNameAr ?? areaNameEn) : areaNameEn;
  String emirateName(String locale) =>
      locale == 'ar' ? (emirateNameAr ?? emirateNameEn) : emirateNameEn;

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
    this.cashHandoverAmount = '0.00',
    this.startedAt,
    this.manualOrder = false,
    this.branchLatitude,
    this.branchLongitude,
    this.orderSequence = const [],
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
    deferredOrders: [
      for (final item in _maps(json['deferredOrders']))
        RouteOrder.fromJson(item),
    ],
    nextAreaId: _string(json['nextAreaId']),
    cashHandoverOrderCount: _int(json['cashHandoverOrderCount']),
    cashHandoverAmount: _string(json['cashHandoverAmount']) ?? '0.00',
    startedAt: _string(json['startedAt']),
    manualOrder: _bool(json['manualOrder']),
    branchLatitude: _double(json['branchLatitude']),
    branchLongitude: _double(json['branchLongitude']),
    orderSequence: [
      if (json['orderSequence'] case final List<Object?> ids)
        for (final id in ids)
          if (id is String && id.isNotEmpty) id,
    ],
  );

  final String id, referenceNumber, businessDate, direction, resultSource;
  final String? fallbackReason, nextAreaId;
  final int revision, cashHandoverOrderCount;
  final bool partialOptimization;
  final int? distanceMeters, durationSeconds;
  final List<RouteArea> areas;
  final List<RouteOrder> deferredOrders;
  final String cashHandoverAmount;
  final String? startedAt;
  final bool manualOrder;
  final double? branchLatitude, branchLongitude;

  /// The Driver's own Order order across Areas (empty until he arranges it).
  final List<String> orderSequence;

  bool get isFallback => resultSource != 'provider';
  bool get isStarted => startedAt != null;
  bool get hasBranch => branchLatitude != null && branchLongitude != null;
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
    'cashHandoverAmount': cashHandoverAmount,
    'startedAt': startedAt,
    'manualOrder': manualOrder,
    'branchLatitude': branchLatitude,
    'branchLongitude': branchLongitude,
    'orderSequence': orderSequence,
  };
}

/// One stop of the trip: an Order with the Area it is in.
final class TripStop {
  const TripStop({required this.order, required this.area});
  final RouteOrder order;
  final RouteArea area;
}

/// The trip as the Driver works it: every Order still to deliver, in one
/// list. When he has arranged the route himself his own Order order is used
/// across all Areas (Abu Hail first, Al Awir second, ...); otherwise the
/// Areas' order, then any deferred Orders. The first stop is the current
/// one; "Next" moves it to the end, so nothing is ever dropped.
final class TripPlan {
  TripPlan._(this.stops);

  factory TripPlan.of(RouteRun run) {
    final stops = <TripStop>[
      for (final area in run.areas)
        for (final order in area.orders) TripStop(order: order, area: area),
    ];
    final areaById = {for (final area in run.areas) area.areaId: area};
    for (final order in run.deferredOrders) {
      // A deferred Order is never dropped, even when its Area is not listed.
      final area =
          areaById[order.areaId] ??
          RouteArea(
            areaId: order.areaId ?? '',
            areaNameEn: '',
            emirateNameEn: '',
            isSequenced: false,
            isNew: false,
            status: 'pending',
            orderCount: 1,
            cashHandoverCount: 0,
            orders: [order],
          );
      stops.add(TripStop(order: order, area: area));
    }
    if (run.manualOrder && run.orderSequence.isNotEmpty) {
      final position = {
        for (final (index, id) in run.orderSequence.indexed) id: index,
      };
      final indexed = stops.indexed.toList()
        ..sort((left, right) {
          final a = position[left.$2.order.id];
          final b = position[right.$2.order.id];
          if (a != null && b != null) return a.compareTo(b);
          if (a != null) return -1;
          if (b != null) return 1;
          return left.$1.compareTo(right.$1);
        });
      return TripPlan._(List.unmodifiable([for (final e in indexed) e.$2]));
    }
    return TripPlan._(List.unmodifiable(stops));
  }

  final List<TripStop> stops;

  TripStop? get current => stops.isEmpty ? null : stops.first;
  bool get isFinished => stops.isEmpty;
  int get total => stops.length;

  /// The stops with the one at [from] moved to [to] (both 0-based).
  List<TripStop> moved(int from, int to) {
    final list = [...stops];
    final stop = list.removeAt(from);
    list.insert(to.clamp(0, list.length), stop);
    return list;
  }

  /// "Next": the current stop goes to the end.
  List<TripStop> get afterNext =>
      stops.length < 2 ? stops : moved(0, stops.length - 1);

  /// "Previous": the last stop (the one he passed with Next) comes back to
  /// the front and becomes current again.
  List<TripStop> get afterPrevious =>
      stops.length < 2 ? stops : moved(stops.length - 1, 0);

  /// The stop after the current one, if any.
  TripStop? get following => stops.length < 2 ? null : stops[1];

  /// The route in Area groups, in trip order: each group is one Area with
  /// its stops and their 0-based numbers. An Area visited twice (the Driver
  /// split it) appears as two groups.
  List<({RouteArea area, List<(int, TripStop)> stops})> get areaGroups {
    final groups = <({RouteArea area, List<(int, TripStop)> stops})>[];
    for (final (index, stop) in stops.indexed) {
      if (groups.isNotEmpty && groups.last.area.areaId == stop.area.areaId) {
        groups.last.stops.add((index, stop));
      } else {
        groups.add((area: stop.area, stops: [(index, stop)]));
      }
    }
    return groups;
  }

  /// The Areas in the order first reached.
  List<RouteArea> get areaOrder {
    final seen = <String>{};
    return [
      for (final stop in stops)
        if (seen.add(stop.area.areaId)) stop.area,
    ];
  }

  /// All stops of the Area at [from] (in [areaOrder]) moved together to
  /// Area place [to]; each Area keeps its own Orders in their order.
  List<TripStop> movedArea(int from, int to) {
    final areas = [...areaOrder];
    final area = areas.removeAt(from);
    areas.insert(to.clamp(0, areas.length), area);
    return [
      for (final place in areas)
        for (final stop in stops)
          if (stop.area.areaId == place.areaId) stop,
    ];
  }
}

/// Google Maps directions through the stops' Areas in trip order, so the
/// Driver can see the whole route on the map. Each Area is used once; an
/// Area with a pin is placed by it, otherwise by its name. Google Maps takes
/// at most ten places (nine waypoints and the destination).
Uri? tripOverviewUri(List<TripStop> stops) {
  final points = <String>[];
  for (final stop in stops) {
    final area = stop.area;
    final point = area.hasPin
        ? '${area.latitude},${area.longitude}'
        : area.areaNameEn.trim().isEmpty
        ? ''
        : [
            area.areaNameEn.trim(),
            if (area.emirateNameEn.trim().isNotEmpty) area.emirateNameEn.trim(),
            'United Arab Emirates',
          ].join(', ');
    if (point.isEmpty || points.contains(point)) continue;
    points.add(point);
    if (points.length == 10) break;
  }
  if (points.isEmpty) return null;
  return Uri.https('www.google.com', '/maps/dir/', {
    'api': '1',
    'destination': points.last,
    if (points.length > 1)
      'waypoints': points.sublist(0, points.length - 1).join('|'),
    'travelmode': 'driving',
  });
}

/// An Area the Driver may start his route from (before a route exists).
final class RouteStartArea {
  const RouteStartArea({
    required this.areaId,
    required this.areaNameEn,
    this.areaNameAr,
    required this.emirateNameEn,
    this.emirateNameAr,
  });

  factory RouteStartArea.fromJson(Map<String, dynamic> json) => RouteStartArea(
    areaId: _string(json['areaId']) ?? '',
    areaNameEn: _string(json['areaNameEn']) ?? '',
    areaNameAr: _string(json['areaNameAr']),
    emirateNameEn: _string(json['emirateNameEn']) ?? '',
    emirateNameAr: _string(json['emirateNameAr']),
  );

  final String areaId, areaNameEn, emirateNameEn;
  final String? areaNameAr, emirateNameAr;

  String label(String locale) {
    final area = locale == 'ar' ? (areaNameAr ?? areaNameEn) : areaNameEn;
    final emirate = locale == 'ar'
        ? (emirateNameAr ?? emirateNameEn)
        : emirateNameEn;
    return '$area · $emirate';
  }
}

/// What the Route tab shows. `offline` marks a saved copy served because the
/// server could not be reached; actions are disabled while it is set.
final class RouteState {
  const RouteState({
    required this.enabled,
    this.run,
    this.stale = false,
    this.offline = false,
    this.tripChangedCount,
    this.tripFailedCount = 0,
    this.startAreas = const [],
  });

  factory RouteState.fromJson(
    Map<String, dynamic> json, {
    bool offline = false,
  }) => RouteState(
    enabled: _bool(json['enabled']),
    stale: _bool(json['stale']),
    offline: offline,
    run: json['run'] is Map
        ? RouteRun.fromJson(Map<String, dynamic>.from(json['run'] as Map))
        : null,
    tripChangedCount: switch (json['trip']) {
      {'changedCount': final Object? count} => _int(count),
      _ => null,
    },
    startAreas: [
      for (final item in _maps(json['startAreas']))
        RouteStartArea.fromJson(item),
    ],
    tripFailedCount: switch (json['trip']) {
      {'failedOrderIds': final List<Object?> failed} => failed.length,
      _ => 0,
    },
  );

  final bool enabled, stale, offline;
  final RouteRun? run;

  /// Start trip only: Orders moved to Out for Delivery, and how many could
  /// not be (changed by the office meanwhile).
  final int? tripChangedCount;
  final int tripFailedCount;

  /// Before a route exists: the Areas he may start from.
  final List<RouteStartArea> startAreas;

  Map<String, dynamic> toJson() => {
    'enabled': enabled,
    'stale': false,
    'run': run?.toJson(),
  };
}
