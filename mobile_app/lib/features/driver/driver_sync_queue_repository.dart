import 'package:bluelinegpt_mobile/core/storage/driver_offline_database.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:sqflite/sqflite.dart';

/// The durable Driver status-change sync queue/outbox (Prompt 16 §J), scoped
/// by `(companyId, driverAccountId)` on every read/write exactly like
/// `DriverOfflineCacheRepository` — the same "never an unscoped query"
/// discipline applies here.
abstract interface class DriverSyncQueueRepository {
  Future<void> enqueue(DriverQueueEntry entry);

  /// The next `sequence` for a fresh row against this Order — always
  /// `(max existing sequence for this order_id, any state) + 1`, so queued
  /// actions against the same Order are replayed in the order they were
  /// queued even across separate `enqueue` calls.
  Future<int> nextSequence({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  });

  /// Every row still needing a sync attempt (`pending` or `syncing` — the
  /// latter recovers a row that was mid-flight when the app was killed),
  /// grouped by `orderId`, each group's rows sorted ascending by
  /// `sequence`. Map iteration order is not meaningful; callers may process
  /// different Orders' groups concurrently, but must never reorder a single
  /// group.
  Future<Map<String, List<DriverQueueEntry>>> pendingGroupedByOrder({
    required String companyId,
    required String driverAccountId,
  });

  Future<List<DriverQueueEntry>> forOrder({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  });

  /// The single most-recently-queued row (any state) per Order — drives the
  /// sync-state badge on the Orders list/detail (Prompt 16 §Q/§X) without a
  /// per-Order query.
  Future<Map<String, DriverQueueEntry>> latestEntryByOrder({
    required String companyId,
    required String driverAccountId,
  });

  /// Order ids with any row not yet fully resolved (`pending`, `syncing`,
  /// or `conflict`) — used by `orders()` to decide which cached Orders must
  /// never be silently dropped just because a fresh server list omitted
  /// them (Prompt 16 §E).
  Future<Set<String>> activeOrderIds({
    required String companyId,
    required String driverAccountId,
  });

  Future<void> markSyncing(String localActionId);
  Future<void> markSynced(String localActionId);
  Future<void> markFailed(String localActionId);
  Future<void> markConflict(String localActionId);

  /// A transient failure (still unreachable, or a 5xx) — stays `pending`,
  /// `retryCount` increments, and the row is not attempted again until
  /// `nextEligibleAt`.
  Future<void> incrementRetry(
    String localActionId, {
    required DateTime nextEligibleAt,
  });

  /// Reverts a row that was marked `syncing` back to `pending` without
  /// touching its retry count — used when a sync attempt is aborted by a
  /// session-expiry (401) mid-flight (Prompt 16 §U), which is an auth
  /// problem, not a business rejection of this row.
  Future<void> revertToPending(String localActionId);

  Future<void> deleteRow(String localActionId);

  /// Drops every `synced` row for this identity — called after a
  /// successful `orders()` refresh, once the fresh server state has already
  /// superseded them.
  Future<void> pruneSynced({
    required String companyId,
    required String driverAccountId,
  });

  Future<void> clearAll();
}

final class SqfliteDriverSyncQueueRepository
    implements DriverSyncQueueRepository {
  SqfliteDriverSyncQueueRepository(this._db);
  final DriverOfflineDatabase _db;

  static const _activeStates = ['pending', 'syncing', 'conflict'];
  static const _pendingLikeStates = ['pending', 'syncing'];

  @override
  Future<void> enqueue(DriverQueueEntry entry) async {
    final db = await _db.database;
    await db.insert(
      'driver_sync_queue',
      _toRow(entry),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  @override
  Future<int> nextSequence({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  }) async {
    final db = await _db.database;
    final rows = await db.rawQuery(
      'SELECT MAX(sequence) AS max_sequence FROM driver_sync_queue '
      'WHERE company_id = ? AND driver_account_id = ? AND order_id = ?',
      [companyId, driverAccountId, orderId],
    );
    final max = rows.isEmpty ? null : rows.first['max_sequence'] as int?;
    return (max ?? 0) + 1;
  }

  @override
  Future<Map<String, List<DriverQueueEntry>>> pendingGroupedByOrder({
    required String companyId,
    required String driverAccountId,
  }) async {
    final db = await _db.database;
    final placeholders = _pendingLikeStates.map((_) => '?').join(',');
    final rows = await db.query(
      'driver_sync_queue',
      where:
          'company_id = ? AND driver_account_id = ? AND state IN ($placeholders)',
      whereArgs: [companyId, driverAccountId, ..._pendingLikeStates],
      orderBy: 'order_id ASC, sequence ASC',
    );
    final grouped = <String, List<DriverQueueEntry>>{};
    for (final row in rows) {
      final entry = _fromRow(row);
      (grouped[entry.orderId] ??= []).add(entry);
    }
    return grouped;
  }

  @override
  Future<List<DriverQueueEntry>> forOrder({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  }) async {
    final db = await _db.database;
    final rows = await db.query(
      'driver_sync_queue',
      where: 'company_id = ? AND driver_account_id = ? AND order_id = ?',
      whereArgs: [companyId, driverAccountId, orderId],
      orderBy: 'sequence ASC',
    );
    return [for (final row in rows) _fromRow(row)];
  }

  @override
  Future<Map<String, DriverQueueEntry>> latestEntryByOrder({
    required String companyId,
    required String driverAccountId,
  }) async {
    final db = await _db.database;
    final rows = await db.rawQuery(
      '''
      SELECT t1.* FROM driver_sync_queue t1
      INNER JOIN (
        SELECT order_id, MAX(sequence) AS max_sequence FROM driver_sync_queue
        WHERE company_id = ? AND driver_account_id = ?
        GROUP BY order_id
      ) t2 ON t1.order_id = t2.order_id AND t1.sequence = t2.max_sequence
      WHERE t1.company_id = ? AND t1.driver_account_id = ?
      ''',
      [companyId, driverAccountId, companyId, driverAccountId],
    );
    return {for (final row in rows) row['order_id']! as String: _fromRow(row)};
  }

  @override
  Future<Set<String>> activeOrderIds({
    required String companyId,
    required String driverAccountId,
  }) async {
    final db = await _db.database;
    final placeholders = _activeStates.map((_) => '?').join(',');
    final rows = await db.query(
      'driver_sync_queue',
      columns: ['order_id'],
      where:
          'company_id = ? AND driver_account_id = ? AND state IN ($placeholders)',
      whereArgs: [companyId, driverAccountId, ..._activeStates],
      distinct: true,
    );
    return {for (final row in rows) row['order_id']! as String};
  }

  @override
  Future<void> markSyncing(String localActionId) =>
      _setState(localActionId, 'syncing');

  @override
  Future<void> markSynced(String localActionId) =>
      _setState(localActionId, 'synced');

  @override
  Future<void> markFailed(String localActionId) =>
      _setState(localActionId, 'failed');

  @override
  Future<void> markConflict(String localActionId) =>
      _setState(localActionId, 'conflict');

  @override
  Future<void> revertToPending(String localActionId) =>
      _setState(localActionId, 'pending');

  @override
  Future<void> incrementRetry(
    String localActionId, {
    required DateTime nextEligibleAt,
  }) async {
    final db = await _db.database;
    await db.rawUpdate(
      'UPDATE driver_sync_queue SET state = ?, retry_count = retry_count + 1, '
      'next_eligible_at = ? WHERE local_action_id = ?',
      ['pending', nextEligibleAt.toIso8601String(), localActionId],
    );
  }

  @override
  Future<void> deleteRow(String localActionId) async {
    final db = await _db.database;
    await db.delete(
      'driver_sync_queue',
      where: 'local_action_id = ?',
      whereArgs: [localActionId],
    );
  }

  @override
  Future<void> pruneSynced({
    required String companyId,
    required String driverAccountId,
  }) async {
    final db = await _db.database;
    await db.delete(
      'driver_sync_queue',
      where: 'company_id = ? AND driver_account_id = ? AND state = ?',
      whereArgs: [companyId, driverAccountId, 'synced'],
    );
  }

  @override
  Future<void> clearAll() async {
    final db = await _db.database;
    await db.delete('driver_sync_queue');
  }

  Future<void> _setState(String localActionId, String state) async {
    final db = await _db.database;
    await db.update(
      'driver_sync_queue',
      {'state': state},
      where: 'local_action_id = ?',
      whereArgs: [localActionId],
    );
  }

  static Map<String, Object?> _toRow(DriverQueueEntry entry) => {
    'local_action_id': entry.localActionId,
    'company_id': entry.companyId,
    'driver_account_id': entry.driverAccountId,
    'order_id': entry.orderId,
    'target_status': entry.targetStatus,
    'reason': entry.reason,
    'expected_status': entry.expectedStatus,
    'sequence': entry.sequence,
    'created_at': entry.createdAt.toIso8601String(),
    'retry_count': entry.retryCount,
    'state': entry.state.name,
    'next_eligible_at': entry.nextEligibleAt?.toIso8601String(),
  };

  static DriverQueueEntry _fromRow(Map<String, Object?> row) =>
      DriverQueueEntry(
        localActionId: row['local_action_id']! as String,
        companyId: row['company_id']! as String,
        driverAccountId: row['driver_account_id']! as String,
        orderId: row['order_id']! as String,
        targetStatus: row['target_status']! as String,
        reason: row['reason'] as String?,
        expectedStatus: row['expected_status'] as String?,
        sequence: row['sequence']! as int,
        createdAt: DateTime.parse(row['created_at']! as String),
        retryCount: row['retry_count']! as int,
        state: DriverSyncRowState.values.byName(row['state']! as String),
        nextEligibleAt: row['next_eligible_at'] == null
            ? null
            : DateTime.parse(row['next_eligible_at']! as String),
      );
}
