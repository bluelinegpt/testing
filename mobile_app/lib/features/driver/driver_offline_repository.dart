import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_cache_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_sync_queue_repository.dart';

/// Failure kinds treated as "genuinely offline / network unreachable" —
/// reached-the-server-and-it-said-no (4xx/`ApiFailureKind.validation`,
/// `.unauthorized`, `.forbidden`, `.notFound`, `.conflict`) must always
/// propagate unchanged so e.g. an expired session still shows as expired,
/// never silently falls back to stale cache. `server` (5xx) is
/// deliberately excluded here too — a mutating call failing with a genuine
/// backend error should surface immediately rather than be silently queued
/// for later replay; the sync controller's own retry loop (already-queued
/// rows) does treat 5xx as transient, which is a different, narrower
/// decision (see `driver_sync_controller.dart`).
bool _isConnectivityFailure(ApiFailure failure) =>
    failure.kind == ApiFailureKind.network ||
    failure.kind == ApiFailureKind.timeout ||
    failure.kind == ApiFailureKind.unavailable;

ApiFailure _asFailure(Object error, ApiErrorMapper errorMapper) =>
    error is ApiFailure ? error : errorMapper.map(error);

/// Wraps `ApiDriverRepository` with a durable, Driver-scoped offline cache
/// and sync queue (Prompt 16). Every method tries the network first; a
/// genuine 4xx/5xx business response always propagates unchanged, and only
/// a connectivity-shaped failure falls back to (or, for `changeStatus`,
/// queues against) the local cache.
final class OfflineAwareDriverRepository implements DriverRepository {
  OfflineAwareDriverRepository({
    required this.api,
    required this.cache,
    required this.queue,
    required this.currentUser,
    required this.errorMapper,
  });

  /// The plain online `ApiDriverRepository` (typed as `DriverRepository`) —
  /// never wrapped again, so `DriverSyncController` can also hold a
  /// reference to attempt a queued replay directly, bypassing this class's
  /// own offline-queueing behavior (replaying an already-queued row must
  /// never enqueue a second row for the same action).
  final DriverRepository api;
  final DriverOfflineCacheRepository cache;
  final DriverSyncQueueRepository queue;
  final AuthenticatedUser? Function() currentUser;
  final ApiErrorMapper errorMapper;

  bool _lastOrdersFromCache = false;
  bool _lastDashboardFromCache = false;

  AuthenticatedUser _requireUser() {
    final user = currentUser();
    if (user == null) {
      throw const ApiFailure(ApiFailureKind.unauthorized);
    }
    return user;
  }

  @override
  Future<List<DriverOrder>> orders() async {
    final user = _requireUser();
    try {
      final fresh = await api.orders();
      final activeIds = await queue.activeOrderIds(
        companyId: user.companyId,
        driverAccountId: user.id,
      );
      await cache.cacheOrders(
        companyId: user.companyId,
        driverAccountId: user.id,
        orders: fresh,
        syncedAt: DateTime.now().toUtc(),
        preserveOrderIds: activeIds,
      );
      await cache.pruneHistoryForMissingOrders(
        companyId: user.companyId,
        driverAccountId: user.id,
      );
      await queue.pruneSynced(
        companyId: user.companyId,
        driverAccountId: user.id,
      );
      _lastOrdersFromCache = false;
      return fresh;
    } on Object catch (error) {
      final failure = _asFailure(error, errorMapper);
      if (!_isConnectivityFailure(failure)) rethrow;
      _lastOrdersFromCache = true;
      return cache.cachedOrders(
        companyId: user.companyId,
        driverAccountId: user.id,
      );
    }
  }

  /// Freshness of the list returned by the most recent `orders()` call for
  /// the current identity — pages call this immediately after `orders()`
  /// to drive the "Offline — Last synced: …" banner (Prompt 16 §F).
  Future<DriverDataFreshness> ordersFreshness() async {
    final user = _requireUser();
    final syncedAt = await cache.ordersLastSyncedAt(
      companyId: user.companyId,
      driverAccountId: user.id,
    );
    return DriverDataFreshness(
      isOffline: _lastOrdersFromCache,
      lastSyncedAt: syncedAt,
    );
  }

  @override
  Future<DriverDashboardSummary> dashboardSummary() async {
    final user = _requireUser();
    try {
      final fresh = await api.dashboardSummary();
      await cache.cacheDashboard(
        companyId: user.companyId,
        driverAccountId: user.id,
        summary: fresh,
        syncedAt: DateTime.now().toUtc(),
      );
      _lastDashboardFromCache = false;
      return fresh;
    } on Object catch (error) {
      final failure = _asFailure(error, errorMapper);
      if (!_isConnectivityFailure(failure)) rethrow;
      final cached = await cache.cachedDashboard(
        companyId: user.companyId,
        driverAccountId: user.id,
      );
      if (cached == null) rethrow;
      _lastDashboardFromCache = true;
      return cached;
    }
  }

  Future<DriverDataFreshness> dashboardFreshness() async {
    final user = _requireUser();
    final syncedAt = await cache.dashboardLastSyncedAt(
      companyId: user.companyId,
      driverAccountId: user.id,
    );
    return DriverDataFreshness(
      isOffline: _lastDashboardFromCache,
      lastSyncedAt: syncedAt,
    );
  }

  @override
  Future<List<DriverOrderHistoryEvent>> history(String orderId) async {
    final user = _requireUser();
    try {
      final fresh = await api.history(orderId);
      await cache.cacheHistory(
        companyId: user.companyId,
        driverAccountId: user.id,
        orderId: orderId,
        events: fresh,
      );
      return fresh;
    } on Object catch (error) {
      final failure = _asFailure(error, errorMapper);
      if (!_isConnectivityFailure(failure)) rethrow;
      return cache.cachedHistory(
        companyId: user.companyId,
        driverAccountId: user.id,
        orderId: orderId,
      );
    }
  }

  @override
  Future<DriverOrder> changeStatus(
    String orderId,
    String status,
    String idempotencyKey, {
    String? reason,
    String? expectedStatus,
  }) async {
    final user = _requireUser();
    try {
      final updated = await api.changeStatus(
        orderId,
        status,
        idempotencyKey,
        reason: reason,
        expectedStatus: expectedStatus,
      );
      await cache.upsertOrder(
        companyId: user.companyId,
        driverAccountId: user.id,
        order: updated,
        syncedAt: DateTime.now().toUtc(),
      );
      return updated;
    } on Object catch (error) {
      final failure = _asFailure(error, errorMapper);
      if (!_isConnectivityFailure(failure)) rethrow;
      return _queueStatusChange(
        user: user,
        orderId: orderId,
        status: status,
        idempotencyKey: idempotencyKey,
        reason: reason,
        expectedStatus: expectedStatus,
      );
    }
  }

  Future<DriverOrder> _queueStatusChange({
    required AuthenticatedUser user,
    required String orderId,
    required String status,
    required String idempotencyKey,
    String? reason,
    String? expectedStatus,
  }) async {
    final cachedBefore = await cache.cachedOrder(
      companyId: user.companyId,
      driverAccountId: user.id,
      orderId: orderId,
    );
    final effectiveExpectedStatus =
        expectedStatus ?? cachedBefore?.status ?? status;
    final sequence = await queue.nextSequence(
      companyId: user.companyId,
      driverAccountId: user.id,
      orderId: orderId,
    );
    await queue.enqueue(
      DriverQueueEntry(
        localActionId: idempotencyKey,
        companyId: user.companyId,
        driverAccountId: user.id,
        orderId: orderId,
        targetStatus: status,
        reason: reason,
        expectedStatus: effectiveExpectedStatus,
        sequence: sequence,
        createdAt: DateTime.now().toUtc(),
        state: DriverSyncRowState.pending,
      ),
    );
    if (cachedBefore == null) {
      // Nothing cached to optimistically update against (e.g. Order list
      // was never successfully synced) — the action is still durably
      // queued and will be replayed once connectivity returns, but there is
      // no local Order snapshot to hand back. Surface the original
      // connectivity failure so the caller does not treat this as success
      // without any Order to show.
      throw const ApiFailure(ApiFailureKind.network);
    }
    final optimistic = await cache.applyOptimisticStatus(
      companyId: user.companyId,
      driverAccountId: user.id,
      orderId: orderId,
      status: status,
    );
    return optimistic ?? cachedBefore;
  }

  /// Every queued action for one Order, most-recently-queued last — used to
  /// derive the sync-state badge (Prompt 16 §Q/§X). Empty when the Order has
  /// no unsynced history.
  Future<List<DriverQueueEntry>> queueEntriesForOrder(String orderId) {
    final user = _requireUser();
    return queue.forOrder(
      companyId: user.companyId,
      driverAccountId: user.id,
      orderId: orderId,
    );
  }

  /// The single most-recently-queued row per Order for the current
  /// identity, keyed by `orderId` — used for the Orders list's badges
  /// without one query per row.
  Future<Map<String, DriverQueueEntry>> latestQueueEntriesByOrder() {
    final user = _requireUser();
    return queue.latestEntryByOrder(
      companyId: user.companyId,
      driverAccountId: user.id,
    );
  }

  /// Manual "Retry" for a `failed` row (Prompt 16 §J) — the old
  /// `local_action_id` is provably burnt (an `idempotency_key_reused` /
  /// `order_status_change_in_progress` response), so this deletes it and
  /// enqueues a fresh row with a brand-new id, never reusing the old key.
  Future<void> retryFailedEntry({
    required DriverQueueEntry entry,
    required String newLocalActionId,
  }) async {
    final user = _requireUser();
    await queue.deleteRow(entry.localActionId);
    final sequence = await queue.nextSequence(
      companyId: user.companyId,
      driverAccountId: user.id,
      orderId: entry.orderId,
    );
    await queue.enqueue(
      DriverQueueEntry(
        localActionId: newLocalActionId,
        companyId: entry.companyId,
        driverAccountId: entry.driverAccountId,
        orderId: entry.orderId,
        targetStatus: entry.targetStatus,
        reason: entry.reason,
        expectedStatus: entry.expectedStatus,
        sequence: sequence,
        createdAt: DateTime.now().toUtc(),
        state: DriverSyncRowState.pending,
      ),
    );
  }

  /// "Needs Review" resolution (Prompt 16 §Q) — re-fetches the real Order
  /// from the server and discards the stale `conflict` queue row(s) for it.
  Future<DriverOrder?> refreshAfterConflict(String orderId) async {
    final user = _requireUser();
    for (final entry in await queue.forOrder(
      companyId: user.companyId,
      driverAccountId: user.id,
      orderId: orderId,
    )) {
      if (entry.state == DriverSyncRowState.conflict) {
        await queue.deleteRow(entry.localActionId);
      }
    }
    final refreshed = await orders();
    for (final order in refreshed) {
      if (order.id == orderId) return order;
    }
    return cache.cachedOrder(
      companyId: user.companyId,
      driverAccountId: user.id,
      orderId: orderId,
    );
  }
}
