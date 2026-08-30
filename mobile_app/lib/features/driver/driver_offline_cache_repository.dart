import 'package:bluelinegpt_mobile/core/storage/driver_offline_database.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:sqflite/sqflite.dart';

/// Maps a `DriverOrder` to/from a `driver_orders_cache` row. Kept as a
/// standalone codec rather than `fromCacheRow`/`toCacheRow` members on
/// `DriverOrder` itself, since `DriverOrder` has no concept of the
/// (`companyId`, `driverAccountId`, `lastSyncedAt`) scoping columns that only
/// the cache row carries — adding them to the domain model would leak a
/// storage concern into something every non-offline call site also
/// constructs.
abstract final class DriverOrderCacheCodec {
  static Map<String, Object?> toRow(
    DriverOrder order, {
    required String companyId,
    required String driverAccountId,
    required String lastSyncedAt,
  }) => {
    'order_id': order.id,
    'company_id': companyId,
    'driver_account_id': driverAccountId,
    'order_number': order.orderNumber,
    'serial_number': order.serialNumber,
    'psystem_serial': order.psystemSerial,
    'reference': order.reference,
    'order_date': order.orderDate,
    'customer_name': order.customerName,
    'customer_mobile': order.customerMobile,
    'emirate_name_en': order.emirateNameEn,
    'emirate_name_ar': order.emirateNameAr,
    'area_id': order.areaId,
    'area_name': order.areaName,
    'address': order.address,
    'expected_cod': order.expectedCod,
    'amount_collected': order.amountCollected,
    'status': order.status,
    'trader_name': order.traderName,
    'notes': order.notes,
    'last_synced_at': lastSyncedAt,
  };

  static DriverOrder fromRow(Map<String, Object?> row) => DriverOrder(
    id: row['order_id']! as String,
    orderNumber: row['order_number']! as String,
    serialNumber: row['serial_number']! as String,
    psystemSerial: row['psystem_serial'] as String?,
    orderDate: row['order_date']! as String,
    areaId: row['area_id']! as String,
    areaName: row['area_name']! as String,
    customerName: row['customer_name']! as String,
    customerMobile: row['customer_mobile']! as String,
    address: row['address']! as String,
    expectedCod: row['expected_cod']! as String,
    amountCollected: row['amount_collected']! as String,
    status: row['status']! as String,
    traderName: row['trader_name']! as String,
    reference: row['reference'] as String?,
    notes: row['notes'] as String?,
    emirateNameEn: row['emirate_name_en'] as String?,
    emirateNameAr: row['emirate_name_ar'] as String?,
  );
}

/// Every read and write of the Driver offline cache (Orders, per-Order
/// History, Dashboard) is scoped by `(companyId, driverAccountId)` for the
/// *currently* authenticated identity — enforced centrally here so no call
/// site can accidentally see or touch another Driver's, or another
/// Company's, cached data (Prompt 16 §C — the single most important
/// security property in this feature). There is deliberately no unscoped
/// query method on this interface.
abstract interface class DriverOfflineCacheRepository {
  Future<void> cacheOrders({
    required String companyId,
    required String driverAccountId,
    required List<DriverOrder> orders,
    required DateTime syncedAt,
    required Set<String> preserveOrderIds,
  });

  Future<List<DriverOrder>> cachedOrders({
    required String companyId,
    required String driverAccountId,
  });

  Future<DriverOrder?> cachedOrder({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  });

  Future<DateTime?> ordersLastSyncedAt({
    required String companyId,
    required String driverAccountId,
  });

  /// Write-through of a single Order (e.g. after a successful status change
  /// or sync) — always bumps `last_synced_at` for that row.
  Future<void> upsertOrder({
    required String companyId,
    required String driverAccountId,
    required DriverOrder order,
    required DateTime syncedAt,
  });

  /// Patches only the `status` column for an optimistic "queued while
  /// offline" transition (Prompt 16 §H) — deliberately leaves
  /// `last_synced_at` untouched, since this is not a real sync.
  Future<DriverOrder?> applyOptimisticStatus({
    required String companyId,
    required String driverAccountId,
    required String orderId,
    required String status,
  });

  Future<void> cacheHistory({
    required String companyId,
    required String driverAccountId,
    required String orderId,
    required List<DriverOrderHistoryEvent> events,
  });

  Future<List<DriverOrderHistoryEvent>> cachedHistory({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  });

  Future<void> cacheDashboard({
    required String companyId,
    required String driverAccountId,
    required DriverDashboardSummary summary,
    required DateTime syncedAt,
  });

  Future<DriverDashboardSummary?> cachedDashboard({
    required String companyId,
    required String driverAccountId,
  });

  Future<DateTime?> dashboardLastSyncedAt({
    required String companyId,
    required String driverAccountId,
  });

  /// Prunes bounded per-Order History retention (Prompt 16 §AB) — drops any
  /// cached History rows for Orders no longer present in
  /// `driver_orders_cache` for this identity. Called after every successful
  /// `orders()` sync.
  Future<void> pruneHistoryForMissingOrders({
    required String companyId,
    required String driverAccountId,
  });
}

final class SqfliteDriverOfflineCacheRepository
    implements DriverOfflineCacheRepository {
  SqfliteDriverOfflineCacheRepository(this._db);
  final DriverOfflineDatabase _db;

  /// Most recent Events per Order kept locally — History is only ever
  /// fetched on-demand (never proactively synced for every Order), so this
  /// stays small in practice.
  static const _historyRetentionPerOrder = 20;

  @override
  Future<void> cacheOrders({
    required String companyId,
    required String driverAccountId,
    required List<DriverOrder> orders,
    required DateTime syncedAt,
    required Set<String> preserveOrderIds,
  }) async {
    final db = await _db.database;
    final syncedAtIso = syncedAt.toIso8601String();
    await db.transaction((txn) async {
      final freshIds = orders.map((o) => o.id).toSet();
      final existing = await txn.query(
        'driver_orders_cache',
        columns: ['order_id'],
        where: 'company_id = ? AND driver_account_id = ?',
        whereArgs: [companyId, driverAccountId],
      );
      for (final row in existing) {
        final id = row['order_id']! as String;
        if (freshIds.contains(id) || preserveOrderIds.contains(id)) continue;
        await txn.delete(
          'driver_orders_cache',
          where: 'order_id = ? AND company_id = ? AND driver_account_id = ?',
          whereArgs: [id, companyId, driverAccountId],
        );
      }
      for (final order in orders) {
        await txn.insert(
          'driver_orders_cache',
          DriverOrderCacheCodec.toRow(
            order,
            companyId: companyId,
            driverAccountId: driverAccountId,
            lastSyncedAt: syncedAtIso,
          ),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
    });
  }

  @override
  Future<List<DriverOrder>> cachedOrders({
    required String companyId,
    required String driverAccountId,
  }) async {
    final db = await _db.database;
    final rows = await db.query(
      'driver_orders_cache',
      where: 'company_id = ? AND driver_account_id = ?',
      whereArgs: [companyId, driverAccountId],
    );
    return [for (final row in rows) DriverOrderCacheCodec.fromRow(row)];
  }

  @override
  Future<DriverOrder?> cachedOrder({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  }) async {
    final db = await _db.database;
    final rows = await db.query(
      'driver_orders_cache',
      where: 'order_id = ? AND company_id = ? AND driver_account_id = ?',
      whereArgs: [orderId, companyId, driverAccountId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return DriverOrderCacheCodec.fromRow(rows.first);
  }

  @override
  Future<DateTime?> ordersLastSyncedAt({
    required String companyId,
    required String driverAccountId,
  }) async {
    final db = await _db.database;
    final rows = await db.query(
      'driver_orders_cache',
      columns: ['last_synced_at'],
      where: 'company_id = ? AND driver_account_id = ?',
      whereArgs: [companyId, driverAccountId],
      orderBy: 'last_synced_at DESC',
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return DateTime.tryParse(rows.first['last_synced_at']! as String);
  }

  @override
  Future<void> upsertOrder({
    required String companyId,
    required String driverAccountId,
    required DriverOrder order,
    required DateTime syncedAt,
  }) async {
    final db = await _db.database;
    await db.insert(
      'driver_orders_cache',
      DriverOrderCacheCodec.toRow(
        order,
        companyId: companyId,
        driverAccountId: driverAccountId,
        lastSyncedAt: syncedAt.toIso8601String(),
      ),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  @override
  Future<DriverOrder?> applyOptimisticStatus({
    required String companyId,
    required String driverAccountId,
    required String orderId,
    required String status,
  }) async {
    final db = await _db.database;
    await db.update(
      'driver_orders_cache',
      {'status': status},
      where: 'order_id = ? AND company_id = ? AND driver_account_id = ?',
      whereArgs: [orderId, companyId, driverAccountId],
    );
    return cachedOrder(
      companyId: companyId,
      driverAccountId: driverAccountId,
      orderId: orderId,
    );
  }

  @override
  Future<void> cacheHistory({
    required String companyId,
    required String driverAccountId,
    required String orderId,
    required List<DriverOrderHistoryEvent> events,
  }) async {
    final db = await _db.database;
    final sorted = [...events]
      ..sort((a, b) {
        final aTime = DateTime.tryParse(a.occurredAt);
        final bTime = DateTime.tryParse(b.occurredAt);
        if (aTime == null || bTime == null) return 0;
        return aTime.compareTo(bTime);
      });
    final bounded = sorted.length > _historyRetentionPerOrder
        ? sorted.sublist(sorted.length - _historyRetentionPerOrder)
        : sorted;
    await db.transaction((txn) async {
      await txn.delete(
        'driver_order_history_cache',
        where: 'order_id = ? AND company_id = ? AND driver_account_id = ?',
        whereArgs: [orderId, companyId, driverAccountId],
      );
      for (final (index, event) in bounded.indexed) {
        await txn.insert('driver_order_history_cache', {
          'order_id': orderId,
          'company_id': companyId,
          'driver_account_id': driverAccountId,
          'sort_index': index,
          'from_status': event.fromStatus,
          'to_status': event.toStatus,
          'occurred_at': event.occurredAt,
        });
      }
    });
  }

  @override
  Future<List<DriverOrderHistoryEvent>> cachedHistory({
    required String companyId,
    required String driverAccountId,
    required String orderId,
  }) async {
    final db = await _db.database;
    final rows = await db.query(
      'driver_order_history_cache',
      where: 'order_id = ? AND company_id = ? AND driver_account_id = ?',
      whereArgs: [orderId, companyId, driverAccountId],
      orderBy: 'sort_index ASC',
    );
    return [
      for (final row in rows)
        DriverOrderHistoryEvent(
          fromStatus: row['from_status'] as String?,
          toStatus: row['to_status']! as String,
          occurredAt: row['occurred_at']! as String,
        ),
    ];
  }

  @override
  Future<void> cacheDashboard({
    required String companyId,
    required String driverAccountId,
    required DriverDashboardSummary summary,
    required DateTime syncedAt,
  }) async {
    final db = await _db.database;
    await db.insert('driver_dashboard_cache', {
      'company_id': companyId,
      'driver_account_id': driverAccountId,
      'active_total': summary.activeTotal,
      'assigned_to_me': summary.assignedToMe,
      'delivered_today': summary.deliveredToday,
      'out_for_delivery': summary.outForDelivery,
      'return_pending': summary.returnPending,
      'last_synced_at': syncedAt.toIso8601String(),
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  @override
  Future<DriverDashboardSummary?> cachedDashboard({
    required String companyId,
    required String driverAccountId,
  }) async {
    final db = await _db.database;
    final rows = await db.query(
      'driver_dashboard_cache',
      where: 'company_id = ? AND driver_account_id = ?',
      whereArgs: [companyId, driverAccountId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final row = rows.first;
    return DriverDashboardSummary(
      activeTotal: row['active_total']! as int,
      assignedToMe: row['assigned_to_me']! as int,
      deliveredToday: row['delivered_today']! as int,
      outForDelivery: row['out_for_delivery']! as int,
      returnPending: row['return_pending']! as int,
    );
  }

  @override
  Future<DateTime?> dashboardLastSyncedAt({
    required String companyId,
    required String driverAccountId,
  }) async {
    final db = await _db.database;
    final rows = await db.query(
      'driver_dashboard_cache',
      columns: ['last_synced_at'],
      where: 'company_id = ? AND driver_account_id = ?',
      whereArgs: [companyId, driverAccountId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return DateTime.tryParse(rows.first['last_synced_at']! as String);
  }

  @override
  Future<void> pruneHistoryForMissingOrders({
    required String companyId,
    required String driverAccountId,
  }) async {
    final db = await _db.database;
    await db.rawDelete(
      'DELETE FROM driver_order_history_cache '
      'WHERE company_id = ? AND driver_account_id = ? AND order_id NOT IN '
      '(SELECT order_id FROM driver_orders_cache '
      ' WHERE company_id = ? AND driver_account_id = ?)',
      [companyId, driverAccountId, companyId, driverAccountId],
    );
  }
}
