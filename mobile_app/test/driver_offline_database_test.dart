import 'dart:io';

import 'package:bluelinegpt_mobile/core/storage/driver_offline_database.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_cache_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_sync_queue_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// Exercises the real `sqflite` schema and scoping queries end to end (the
/// standard, well-supported headless-desktop way to test real `sqflite`
/// code in `flutter test`, per `sqflite_common_ffi`). Everything else in
/// this feature — `OfflineAwareDriverRepository`/`DriverSyncController`
/// logic — is tested against hand-written in-memory Fakes of these same
/// repository interfaces (see `driver_offline_repository_test.dart` /
/// `driver_sync_controller_test.dart`); this file exists to prove the SQL
/// itself (in particular the scoping predicates, since a bug there would
/// defeat Prompt 16 §C even if every Fake-based test passed).
DriverOrder _order({
  String id = 'order-1',
  String status = 'assigned_to_driver',
}) => DriverOrder(
  id: id,
  orderNumber: 'ORD-1',
  serialNumber: 'SN-1',
  orderDate: '2026-08-09',
  areaId: 'area-1',
  areaName: 'Deira',
  customerName: 'Customer A',
  customerMobile: '971500000000',
  address: '123 Main Street',
  expectedCod: '100.00',
  amountCollected: '0.00',
  status: status,
  traderName: 'Plaza Store',
);

void main() {
  late Directory tempDir;
  late String dbPath;
  late List<DriverOfflineDatabase> opened;

  setUpAll(() {
    sqfliteFfiInit();
  });

  setUp(() {
    tempDir = Directory.systemTemp.createTempSync('driver_offline_db_test');
    dbPath = '${tempDir.path}${Platform.pathSeparator}driver_offline_test.db';
    opened = [];
  });

  tearDown(() async {
    // Windows will not delete a file with an open handle — every database
    // opened during the test must be closed first (a real app-restart
    // scenario cannot leak an open handle either).
    for (final db in opened) {
      await db.close();
    }
    if (tempDir.existsSync()) tempDir.deleteSync(recursive: true);
  });

  DriverOfflineDatabase newDb() {
    final db = DriverOfflineDatabase(
      factoryOverride: databaseFactoryFfi,
      pathOverride: dbPath,
    );
    opened.add(db);
    return db;
  }

  test(
    'cache reads/writes are isolated per (companyId, driverAccountId)',
    () async {
      final cache = SqfliteDriverOfflineCacheRepository(newDb());
      await cache.cacheOrders(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orders: [_order(id: 'order-a')],
        syncedAt: DateTime.utc(2026, 8, 9),
        preserveOrderIds: const {},
      );
      await cache.cacheOrders(
        companyId: 'company-1',
        driverAccountId: 'driver-2',
        orders: [_order(id: 'order-b')],
        syncedAt: DateTime.utc(2026, 8, 9),
        preserveOrderIds: const {},
      );
      await cache.cacheOrders(
        companyId: 'company-2',
        driverAccountId: 'driver-1',
        orders: [_order(id: 'order-c')],
        syncedAt: DateTime.utc(2026, 8, 9),
        preserveOrderIds: const {},
      );

      final driver1Company1 = await cache.cachedOrders(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
      );
      expect(driver1Company1.map((o) => o.id), ['order-a']);

      final driver2Company1 = await cache.cachedOrders(
        companyId: 'company-1',
        driverAccountId: 'driver-2',
      );
      expect(driver2Company1.map((o) => o.id), ['order-b']);

      // Same driverAccountId, different companyId — must not leak either.
      final driver1Company2 = await cache.cachedOrders(
        companyId: 'company-2',
        driverAccountId: 'driver-1',
      );
      expect(driver1Company2.map((o) => o.id), ['order-c']);
    },
  );

  test(
    'sync queue sequence is per-Order and monotonically increasing',
    () async {
      final queue = SqfliteDriverSyncQueueRepository(newDb());
      final first = await queue.nextSequence(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orderId: 'order-1',
      );
      expect(first, 1);
      await queue.enqueue(
        DriverQueueEntry(
          localActionId: 'action-1',
          companyId: 'company-1',
          driverAccountId: 'driver-1',
          orderId: 'order-1',
          targetStatus: 'out_for_delivery',
          sequence: first,
          createdAt: DateTime.utc(2026, 8, 9),
          state: DriverSyncRowState.pending,
        ),
      );
      final second = await queue.nextSequence(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orderId: 'order-1',
      );
      expect(second, 2);
      // A different Order starts its own independent sequence at 1.
      final otherOrderFirst = await queue.nextSequence(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orderId: 'order-2',
      );
      expect(otherOrderFirst, 1);
    },
  );

  test(
    'pendingGroupedByOrder returns each group sorted ascending by sequence',
    () async {
      final queue = SqfliteDriverSyncQueueRepository(newDb());
      for (final seq in [2, 1, 3]) {
        await queue.enqueue(
          DriverQueueEntry(
            localActionId: 'action-$seq',
            companyId: 'company-1',
            driverAccountId: 'driver-1',
            orderId: 'order-1',
            targetStatus: 'status-$seq',
            sequence: seq,
            createdAt: DateTime.utc(2026, 8, 9),
            state: DriverSyncRowState.pending,
          ),
        );
      }
      final grouped = await queue.pendingGroupedByOrder(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
      );
      expect(grouped['order-1']!.map((e) => e.sequence), [1, 2, 3]);
    },
  );

  test('clearAll wipes every table', () async {
    final db = newDb();
    final cache = SqfliteDriverOfflineCacheRepository(db);
    final queue = SqfliteDriverSyncQueueRepository(db);
    await cache.cacheOrders(
      companyId: 'company-1',
      driverAccountId: 'driver-1',
      orders: [_order()],
      syncedAt: DateTime.utc(2026, 8, 9),
      preserveOrderIds: const {},
    );
    await queue.enqueue(
      DriverQueueEntry(
        localActionId: 'action-1',
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orderId: 'order-1',
        targetStatus: 'out_for_delivery',
        sequence: 1,
        createdAt: DateTime.utc(2026, 8, 9),
        state: DriverSyncRowState.pending,
      ),
    );
    await db.clearScope(userId: 'driver-1', companyId: 'company-1');
    expect(
      await cache.cachedOrders(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
      ),
      isEmpty,
    );
    expect(
      await queue.forOrder(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orderId: 'order-1',
      ),
      isEmpty,
    );
  });

  test(
    'state survives a fresh DriverOfflineDatabase instance opened against the '
    'same file — a proxy for an app restart',
    () async {
      final firstInstance = newDb();
      final cache = SqfliteDriverOfflineCacheRepository(firstInstance);
      await cache.cacheOrders(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orders: [_order(id: 'order-survives')],
        syncedAt: DateTime.utc(2026, 8, 9),
        preserveOrderIds: const {},
      );
      await firstInstance.close();

      // A brand-new object, no shared in-memory state, pointed at the same
      // on-disk file — exactly what happens on a real process restart.
      final secondInstance = newDb();
      final reopenedCache = SqfliteDriverOfflineCacheRepository(secondInstance);
      final survived = await reopenedCache.cachedOrders(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
      );
      expect(survived.map((o) => o.id), ['order-survives']);
    },
  );

  test(
    'History retention is bounded to the most recent 20 events per Order',
    () async {
      final cache = SqfliteDriverOfflineCacheRepository(newDb());
      final events = [
        for (var i = 0; i < 25; i++)
          DriverOrderHistoryEvent(
            toStatus: 'status-$i',
            occurredAt: DateTime.utc(2026, 1, 1, i).toIso8601String(),
          ),
      ];
      await cache.cacheHistory(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orderId: 'order-1',
        events: events,
      );
      final cached = await cache.cachedHistory(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orderId: 'order-1',
      );
      expect(cached, hasLength(20));
      // The most recent 20 are kept — the oldest 5 (status-0..status-4) drop.
      expect(cached.first.toStatus, 'status-5');
      expect(cached.last.toStatus, 'status-24');
    },
  );
}
