import 'dart:convert';

import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';
import 'package:bluelinegpt_mobile/features/driver/route/route_models.dart';
import 'package:dio/dio.dart';

/// The Driver's route over `portal/driver/route`. Every write sends an
/// idempotency key, so a double tap on a slow connection cannot record two
/// actions; replan, reverse and defer send the revision the screen shows,
/// and a stale one returns the current route instead of acting on it.
abstract interface class DriverRouteRepository {
  Future<RouteState> current();
  Future<RouteState> plan(String idempotencyKey, {String? startAreaId});
  Future<RouteState> replan(
    String idempotencyKey,
    int expectedRevision, {
    String? startAreaId,
  });
  Future<RouteState> reverse(String idempotencyKey, int expectedRevision);
  Future<RouteState> defer(
    String idempotencyKey,
    String orderId,
    int expectedRevision,
  );
}

final class ApiDriverRouteRepository implements DriverRouteRepository {
  ApiDriverRouteRepository(this.api);
  final ApiClient api;

  @override
  Future<RouteState> current() async =>
      _state((await api.get<Object?>('portal/driver/route')).data);

  @override
  Future<RouteState> plan(String idempotencyKey, {String? startAreaId}) =>
      _post('plan', idempotencyKey, {'startAreaId': ?startAreaId});

  @override
  Future<RouteState> replan(
    String idempotencyKey,
    int expectedRevision, {
    String? startAreaId,
  }) => _post('replan', idempotencyKey, {
    'expectedRevision': expectedRevision,
    'startAreaId': ?startAreaId,
  });

  @override
  Future<RouteState> reverse(String idempotencyKey, int expectedRevision) =>
      _post('reverse', idempotencyKey, {'expectedRevision': expectedRevision});

  @override
  Future<RouteState> defer(
    String idempotencyKey,
    String orderId,
    int expectedRevision,
  ) => _post('defer', idempotencyKey, {
    'orderId': orderId,
    'expectedRevision': expectedRevision,
  });

  Future<RouteState> _post(
    String action,
    String idempotencyKey,
    Map<String, Object?> body,
  ) async {
    final response = await api.postWithHeaders<Object?>(
      'portal/driver/route/$action',
      headers: {'X-Idempotency-Key': idempotencyKey},
      data: body,
    );
    return _state(response.data);
  }

  static RouteState _state(Object? data) {
    if (data is! Map) throw const ApiFailure(ApiFailureKind.invalidResponse);
    return RouteState.fromJson(Map<String, dynamic>.from(data));
  }
}

/// Keeps the last route the server returned, so a Driver who loses signal
/// mid-run still sees his sequence. The copy is session data
/// (`SensitiveKey.driverRouteCache`), cleared on logout with the rest of the
/// session, and only served for the same day it was saved.
final class CachedDriverRouteRepository implements DriverRouteRepository {
  CachedDriverRouteRepository({
    required this.inner,
    required this.storage,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final DriverRouteRepository inner;
  final SensitiveStorage storage;
  final DateTime Function() _clock;

  @override
  Future<RouteState> current() => _guard(inner.current, allowCache: true);

  @override
  Future<RouteState> plan(String idempotencyKey, {String? startAreaId}) =>
      _guard(() => inner.plan(idempotencyKey, startAreaId: startAreaId));

  @override
  Future<RouteState> replan(
    String idempotencyKey,
    int expectedRevision, {
    String? startAreaId,
  }) => _guard(
    () => inner.replan(
      idempotencyKey,
      expectedRevision,
      startAreaId: startAreaId,
    ),
  );

  @override
  Future<RouteState> reverse(String idempotencyKey, int expectedRevision) =>
      _guard(() => inner.reverse(idempotencyKey, expectedRevision));

  @override
  Future<RouteState> defer(
    String idempotencyKey,
    String orderId,
    int expectedRevision,
  ) => _guard(() => inner.defer(idempotencyKey, orderId, expectedRevision));

  Future<RouteState> _guard(
    Future<RouteState> Function() call, {
    bool allowCache = false,
  }) async {
    try {
      final state = await call();
      await _save(state);
      return state;
    } on Object catch (error) {
      if (allowCache && _isConnectivityFailure(error)) {
        final cached = await _load();
        if (cached != null) return cached;
      }
      rethrow;
    }
  }

  static bool _isConnectivityFailure(Object error) {
    final kind = error is ApiFailure
        ? error.kind
        : error is DioException
        ? const ApiErrorMapper().map(error).kind
        : null;
    return kind == ApiFailureKind.network ||
        kind == ApiFailureKind.timeout ||
        kind == ApiFailureKind.unavailable;
  }

  String _today() => _clock().toIso8601String().substring(0, 10);

  Future<void> _save(RouteState state) async {
    try {
      if (!state.enabled) {
        await storage.delete(SensitiveKey.driverRouteCache);
        return;
      }
      await storage.write(
        SensitiveKey.driverRouteCache,
        jsonEncode({'savedOn': _today(), 'state': state.toJson()}),
      );
    } on Object {
      // A failed cache write must never fail the route itself.
    }
  }

  Future<RouteState?> _load() async {
    try {
      final raw = await storage.read(SensitiveKey.driverRouteCache);
      if (raw == null) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map ||
          decoded['savedOn'] != _today() ||
          decoded['state'] is! Map) {
        return null;
      }
      return RouteState.fromJson(
        Map<String, dynamic>.from(decoded['state'] as Map),
        offline: true,
      );
    } on Object {
      return null;
    }
  }
}
