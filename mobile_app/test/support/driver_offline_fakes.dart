import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_cache_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_sync_queue_repository.dart';

/// In-memory doubles for the offline cache/queue repository interfaces —
/// used to test `OfflineAwareDriverRepository` and `DriverSyncController`
/// LOGIC without a real database, mirroring this codebase's established
/// `Fake*` convention (see `FakeDriverRepository` in
/// `driver_dashboard_and_detail_test.dart`). Real `sqflite` (via
/// `sqflite_common_ffi`) is exercised separately and only for the
/// storage-layer itself, in `driver_offline_database_test.dart`.
String _scope(String companyId, String driverAccountId) =>
    '$companyId::$driverAccountId';

final class FakeDriverOfflineCacheRepository
    implements DriverOfflineCacheRepository {
  final Map<String, Map<String, DriverOrder>> _orders = {};
  final Map<String, DateTime> _ordersSyncedAt = {};
  final Map<String, Map<String, List<DriverOrderHistoryEvent>>> _history = {};
  final Map<String, DriverDashboardSummary> _dashboard = {};
  final Map<String, DateTime> _dashboardSyncedAt = {};

  @override
  Future<void> cacheOrders({
    required String companyId,
    required String driverAccountId,
    required List<DriverOrder> orders,
    required DateTime syncedAt,
    required Set<String> preserveOrderIds,
  }) async {
    final scope = _scope(companyId, driverAccountId);
    final existing = _orders[scope] ?? {};
    final freshIds = orders.map((o) => o.id).toSet();
    final next = <String, DriverOrder>{
      for (final entry in existing.entries)
        if (freshIds.contains(entry.key) ||
            preserveOrderIds.contains(entry.key))
          entry.key: entry.value,
    };
    for (final order in orders) {
      next[order.id] = order;
    }
    _orders[scope] = next;
    _ordersSyncedAt[scope] = syncedAt;
  }

  @override
  Future<List<DriverOrder>> cachedOrders({
    required String companyId,
    required String driverAccountId,
  }) async =>
      (_orders[_scope(companyId, driverAccountId)] ?? {}).values.toList();

  @override
  Future<DriverOrder?> cachedOrder({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  }) async => _orders[_scope(companyId, driverAccountId)]?[orderId];

  @override
  Future<DateTime?> ordersLastSyncedAt({
    required String companyId,
    required String driverAccountId,
  }) async => _ordersSyncedAt[_scope(companyId, driverAccountId)];

  @override
  Future<void> upsertOrder({
    required String companyId,
    required String driverAccountId,
    required DriverOrder order,
    required DateTime syncedAt,
  }) async {
    final scope = _scope(companyId, driverAccountId);
    (_orders[scope] ??= {})[order.id] = order;
    _ordersSyncedAt[scope] = syncedAt;
  }

  @override
  Future<DriverOrder?> applyOptimisticStatus({
    required String companyId,
    required String driverAccountId,
    required String orderId,
    required String status,
  }) async {
    final scope = _scope(companyId, driverAccountId);
    final current = _orders[scope]?[orderId];
    if (current == null) return null;
    final updated = DriverOrder(
      id: current.id,
      orderNumber: current.orderNumber,
      serialNumber: current.serialNumber,
      orderDate: current.orderDate,
      areaId: current.areaId,
      areaName: current.areaName,
      customerName: current.customerName,
      customerMobile: current.customerMobile,
      address: current.address,
      expectedCod: current.expectedCod,
      amountCollected: current.amountCollected,
      status: status,
      traderName: current.traderName,
      reference: current.reference,
      notes: current.notes,
      emirateNameEn: current.emirateNameEn,
      emirateNameAr: current.emirateNameAr,
    );
    _orders[scope]![orderId] = updated;
    return updated;
  }

  @override
  Future<void> cacheHistory({
    required String companyId,
    required String driverAccountId,
    required String orderId,
    required List<DriverOrderHistoryEvent> events,
  }) async {
    final scope = _scope(companyId, driverAccountId);
    (_history[scope] ??= {})[orderId] = events;
  }

  @override
  Future<List<DriverOrderHistoryEvent>> cachedHistory({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  }) async =>
      _history[_scope(companyId, driverAccountId)]?[orderId] ?? const [];

  @override
  Future<void> cacheDashboard({
    required String companyId,
    required String driverAccountId,
    required DriverDashboardSummary summary,
    required DateTime syncedAt,
  }) async {
    final scope = _scope(companyId, driverAccountId);
    _dashboard[scope] = summary;
    _dashboardSyncedAt[scope] = syncedAt;
  }

  @override
  Future<DriverDashboardSummary?> cachedDashboard({
    required String companyId,
    required String driverAccountId,
  }) async => _dashboard[_scope(companyId, driverAccountId)];

  @override
  Future<DateTime?> dashboardLastSyncedAt({
    required String companyId,
    required String driverAccountId,
  }) async => _dashboardSyncedAt[_scope(companyId, driverAccountId)];

  @override
  Future<void> pruneHistoryForMissingOrders({
    required String companyId,
    required String driverAccountId,
  }) async {
    final scope = _scope(companyId, driverAccountId);
    final orderIds = (_orders[scope] ?? {}).keys.toSet();
    _history[scope]?.removeWhere((orderId, _) => !orderIds.contains(orderId));
  }
}

final class FakeDriverSyncQueueRepository implements DriverSyncQueueRepository {
  final Map<String, DriverQueueEntry> _rows = {};

  @override
  Future<void> enqueue(DriverQueueEntry entry) async {
    _rows[entry.localActionId] = entry;
  }

  @override
  Future<int> nextSequence({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  }) async {
    final existing = _rows.values.where(
      (row) =>
          row.companyId == companyId &&
          row.driverAccountId == driverAccountId &&
          row.orderId == orderId,
    );
    if (existing.isEmpty) return 1;
    return existing.map((r) => r.sequence).reduce((a, b) => a > b ? a : b) + 1;
  }

  @override
  Future<Map<String, List<DriverQueueEntry>>> pendingGroupedByOrder({
    required String companyId,
    required String driverAccountId,
  }) async {
    final grouped = <String, List<DriverQueueEntry>>{};
    for (final row in _rows.values) {
      if (row.companyId != companyId ||
          row.driverAccountId != driverAccountId) {
        continue;
      }
      if (row.state != DriverSyncRowState.pending &&
          row.state != DriverSyncRowState.syncing) {
        continue;
      }
      (grouped[row.orderId] ??= []).add(row);
    }
    for (final list in grouped.values) {
      list.sort((a, b) => a.sequence.compareTo(b.sequence));
    }
    return grouped;
  }

  @override
  Future<List<DriverQueueEntry>> forOrder({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  }) async {
    final rows =
        _rows.values
            .where(
              (row) =>
                  row.companyId == companyId &&
                  row.driverAccountId == driverAccountId &&
                  row.orderId == orderId,
            )
            .toList()
          ..sort((a, b) => a.sequence.compareTo(b.sequence));
    return rows;
  }

  @override
  Future<Map<String, DriverQueueEntry>> latestEntryByOrder({
    required String companyId,
    required String driverAccountId,
  }) async {
    final byOrder = <String, DriverQueueEntry>{};
    for (final row in _rows.values) {
      if (row.companyId != companyId ||
          row.driverAccountId != driverAccountId) {
        continue;
      }
      final current = byOrder[row.orderId];
      if (current == null || row.sequence > current.sequence) {
        byOrder[row.orderId] = row;
      }
    }
    return byOrder;
  }

  @override
  Future<Set<String>> activeOrderIds({
    required String companyId,
    required String driverAccountId,
  }) async => {
    for (final row in _rows.values)
      if (row.companyId == companyId &&
          row.driverAccountId == driverAccountId &&
          (row.state == DriverSyncRowState.pending ||
              row.state == DriverSyncRowState.syncing ||
              row.state == DriverSyncRowState.conflict))
        row.orderId,
  };

  @override
  Future<void> markSyncing(String localActionId) =>
      _setState(localActionId, DriverSyncRowState.syncing);
  @override
  Future<void> markSynced(String localActionId) =>
      _setState(localActionId, DriverSyncRowState.synced);
  @override
  Future<void> markFailed(String localActionId) =>
      _setState(localActionId, DriverSyncRowState.failed);
  @override
  Future<void> markConflict(String localActionId) =>
      _setState(localActionId, DriverSyncRowState.conflict);
  @override
  Future<void> revertToPending(String localActionId) =>
      _setState(localActionId, DriverSyncRowState.pending);

  @override
  Future<void> incrementRetry(
    String localActionId, {
    required DateTime nextEligibleAt,
  }) async {
    final row = _rows[localActionId];
    if (row == null) return;
    _rows[localActionId] = row.copyWith(
      retryCount: row.retryCount + 1,
      state: DriverSyncRowState.pending,
      nextEligibleAt: nextEligibleAt,
    );
  }

  @override
  Future<void> deleteRow(String localActionId) async {
    _rows.remove(localActionId);
  }

  @override
  Future<void> pruneSynced({
    required String companyId,
    required String driverAccountId,
  }) async {
    _rows.removeWhere(
      (_, row) =>
          row.companyId == companyId &&
          row.driverAccountId == driverAccountId &&
          row.state == DriverSyncRowState.synced,
    );
  }

  @override
  Future<void> clearAll() async => _rows.clear();

  Future<void> _setState(String localActionId, DriverSyncRowState state) async {
    final row = _rows[localActionId];
    if (row == null) return;
    _rows[localActionId] = row.copyWith(state: state);
  }
}

/// A `DriverRepository` double representing the raw online endpoint (never
/// wrapped by `OfflineAwareDriverRepository`) — lets tests script exactly
/// what the "server" does for each attempt, including per-call scripted
/// failures for `DriverSyncController`'s retry/conflict logic.
final class ScriptedApiDriverRepository implements DriverRepository {
  List<DriverOrder> ordersResult = const [];
  Object? ordersError;
  DriverDashboardSummary? dashboardResult;
  Object? dashboardError;
  List<DriverOrderHistoryEvent> historyResult = const [];
  Object? historyError;

  /// One scripted outcome per call, consumed in order; the last entry
  /// repeats once exhausted. Each entry is either a `DriverOrder` (success)
  /// or an `Object` (thrown as-is).
  final List<Object> changeStatusScript = [];
  int changeStatusCalls = 0;
  final List<String> idempotencyKeysUsed = [];
  final List<String?> expectedStatusesUsed = [];

  @override
  Future<List<DriverOrder>> orders() async {
    if (ordersError != null) throw ordersError!;
    return ordersResult;
  }

  @override
  Future<DriverDashboardSummary> dashboardSummary() async {
    if (dashboardError != null) throw dashboardError!;
    return dashboardResult!;
  }

  @override
  Future<List<DriverOrderHistoryEvent>> history(String orderId) async {
    if (historyError != null) throw historyError!;
    return historyResult;
  }

  @override
  Future<DriverOrder> changeStatus(
    String orderId,
    String status,
    String idempotencyKey, {
    String? reason,
    String? expectedStatus,
  }) async {
    idempotencyKeysUsed.add(idempotencyKey);
    expectedStatusesUsed.add(expectedStatus);
    if (changeStatusScript.isEmpty) {
      changeStatusCalls += 1;
      throw const ApiFailure(ApiFailureKind.network);
    }
    final index = changeStatusCalls.clamp(0, changeStatusScript.length - 1);
    changeStatusCalls += 1;
    final outcome = changeStatusScript[index];
    if (outcome is DriverOrder) return outcome;
    throw outcome;
  }
}
