import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_repository.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/driver_offline_fakes.dart';

AuthenticatedUser _user({
  String companyId = 'company-1',
  String id = 'driver-1',
}) => AuthenticatedUser(
  id: id,
  companyId: companyId,
  displayName: 'Driver One',
  roles: {UserRole.driver},
  permissions: const {},
  accessState: AccountAccessState.active,
);

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

final class _Fixture {
  _Fixture({AuthenticatedUser? user}) : user = user ?? _user() {
    repository = OfflineAwareDriverRepository(
      api: api,
      cache: cache,
      queue: queue,
      currentUser: () => this.user,
      errorMapper: const ApiErrorMapper(),
    );
  }
  final AuthenticatedUser user;
  final api = ScriptedApiDriverRepository();
  final cache = FakeDriverOfflineCacheRepository();
  final queue = FakeDriverSyncQueueRepository();
  late final OfflineAwareDriverRepository repository;
}

void main() {
  group('OfflineAwareDriverRepository.orders()', () {
    test(
      'online success writes through the cache and is not offline',
      () async {
        final fixture = _Fixture()..api.ordersResult = [_order()];
        final result = await fixture.repository.orders();
        expect(result, hasLength(1));
        final freshness = await fixture.repository.ordersFreshness();
        expect(freshness.isOffline, isFalse);
        expect(
          await fixture.cache.cachedOrders(
            companyId: fixture.user.companyId,
            driverAccountId: fixture.user.id,
          ),
          hasLength(1),
        );
      },
    );

    test('a connectivity failure falls back to the cached list', () async {
      final fixture = _Fixture();
      await fixture.cache.cacheOrders(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orders: [_order()],
        syncedAt: DateTime.utc(2026, 8, 9, 10),
        preserveOrderIds: const {},
      );
      fixture.api.ordersError = const ApiFailure(ApiFailureKind.network);
      final result = await fixture.repository.orders();
      expect(result, hasLength(1));
      final freshness = await fixture.repository.ordersFreshness();
      expect(freshness.isOffline, isTrue);
      expect(freshness.lastSyncedAt, DateTime.utc(2026, 8, 9, 10));
    });

    test('a business failure (expired session) propagates, never falls back '
        'to cache', () async {
      final fixture = _Fixture();
      await fixture.cache.cacheOrders(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orders: [_order()],
        syncedAt: DateTime.utc(2026, 8, 9),
        preserveOrderIds: const {},
      );
      fixture.api.ordersError = const ApiFailure(
        ApiFailureKind.unauthorized,
        code: 'session_expired',
      );
      expect(fixture.repository.orders(), throwsA(isA<ApiFailure>()));
    });

    test('a genuine server error (HTTP 5xx) propagates and is never silently '
        'misreported as an offline-cache success — a real backend bug must '
        'surface as an error, not be masked behind the "offline, showing '
        'cached data" path (investigation into the intermittent "Data is '
        'currently unavailable" report)', () async {
      final fixture = _Fixture();
      await fixture.cache.cacheOrders(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orders: [_order()],
        syncedAt: DateTime.utc(2026, 8, 9),
        preserveOrderIds: const {},
      );
      fixture.api.ordersError = const ApiFailure(
        ApiFailureKind.server,
        statusCode: 500,
      );
      await expectLater(
        fixture.repository.orders(),
        throwsA(
          isA<ApiFailure>().having(
            (failure) => failure.kind,
            'kind',
            ApiFailureKind.server,
          ),
        ),
      );
      // The freshness indicator must still reflect the last genuinely
      // successful sync, not silently flip to "offline" because of an
      // unrelated 5xx — those are a different category entirely
      // (`_isConnectivityFailure` deliberately excludes `server`).
      final freshness = await fixture.repository.ordersFreshness();
      expect(freshness.isOffline, isFalse);
    });

    test(
      'a fresh list never drops an Order with a pending queue entry',
      () async {
        final fixture = _Fixture();
        await fixture.cache.cacheOrders(
          companyId: fixture.user.companyId,
          driverAccountId: fixture.user.id,
          orders: [
            _order(id: 'order-1'),
            _order(id: 'order-2'),
          ],
          syncedAt: DateTime.utc(2026, 8, 9),
          preserveOrderIds: const {},
        );
        await fixture.queue.enqueue(
          DriverQueueEntry(
            localActionId: 'action-1',
            companyId: fixture.user.companyId,
            driverAccountId: fixture.user.id,
            orderId: 'order-1',
            targetStatus: 'out_for_delivery',
            sequence: 1,
            createdAt: DateTime.utc(2026, 8, 9),
            state: DriverSyncRowState.pending,
          ),
        );
        // The server's fresh list only returns order-2 (e.g. order-1 briefly
        // dropped from the assigned set mid-sync) — order-1 must survive
        // because it has an unsynced local action against it.
        fixture.api.ordersResult = [_order(id: 'order-2')];
        final result = await fixture.repository.orders();
        expect(result.map((o) => o.id), ['order-2']);
        final cached = await fixture.cache.cachedOrders(
          companyId: fixture.user.companyId,
          driverAccountId: fixture.user.id,
        );
        expect(cached.map((o) => o.id), containsAll(['order-1', 'order-2']));
      },
    );
  });

  group('OfflineAwareDriverRepository.changeStatus()', () {
    test('online success writes through the cache', () async {
      final fixture = _Fixture()
        ..api.changeStatusScript.add(_order(status: 'out_for_delivery'));
      final result = await fixture.repository.changeStatus(
        'order-1',
        'out_for_delivery',
        'key-1',
        expectedStatus: 'assigned_to_driver',
      );
      expect(result.status, 'out_for_delivery');
      expect(fixture.api.expectedStatusesUsed.single, 'assigned_to_driver');
    });

    test('a connectivity failure queues the action and optimistically updates '
        'the cache instead of throwing', () async {
      final fixture = _Fixture();
      await fixture.cache.upsertOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        order: _order(status: 'assigned_to_driver'),
        syncedAt: DateTime.utc(2026, 8, 9),
      );
      fixture.api.changeStatusScript.add(
        const ApiFailure(ApiFailureKind.network),
      );
      final result = await fixture.repository.changeStatus(
        'order-1',
        'out_for_delivery',
        'action-key-1',
      );
      expect(result.status, 'out_for_delivery');
      final rows = await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      );
      expect(rows, hasLength(1));
      expect(rows.single.localActionId, 'action-key-1');
      expect(rows.single.state, DriverSyncRowState.pending);
      expect(rows.single.expectedStatus, 'assigned_to_driver');
    });

    test('a second queued action for the same Order chains expectedStatus off '
        "the first action's target, not the original cached status", () async {
      final fixture = _Fixture();
      await fixture.cache.upsertOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        order: _order(status: 'assigned_to_driver'),
        syncedAt: DateTime.utc(2026, 8, 9),
      );
      fixture.api.changeStatusScript.add(
        const ApiFailure(ApiFailureKind.network),
      );
      await fixture.repository.changeStatus(
        'order-1',
        'out_for_delivery',
        'action-1',
      );
      await fixture.repository.changeStatus('order-1', 'delivered', 'action-2');
      final rows = await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      );
      expect(rows, hasLength(2));
      expect(rows[0].expectedStatus, 'assigned_to_driver');
      expect(rows[0].sequence, 1);
      expect(rows[1].expectedStatus, 'out_for_delivery');
      expect(rows[1].sequence, 2);
    });
  });

  group('OfflineAwareDriverRepository.dashboardSummary()', () {
    test('falls back to a cached summary on a connectivity failure', () async {
      final fixture = _Fixture();
      await fixture.cache.cacheDashboard(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        summary: const DriverDashboardSummary(
          activeTotal: 3,
          assignedToMe: 1,
          deliveredToday: 1,
          outForDelivery: 1,
          returnPending: 0,
        ),
        syncedAt: DateTime.utc(2026, 8, 9),
      );
      fixture.api.dashboardError = const ApiFailure(ApiFailureKind.timeout);
      final summary = await fixture.repository.dashboardSummary();
      expect(summary.activeTotal, 3);
      final freshness = await fixture.repository.dashboardFreshness();
      expect(freshness.isOffline, isTrue);
    });

    test(
      'a never-synced identity gets the original failure, not zeros',
      () async {
        final fixture = _Fixture()
          ..api.dashboardError = const ApiFailure(ApiFailureKind.network);
        expect(
          fixture.repository.dashboardSummary(),
          throwsA(isA<ApiFailure>()),
        );
      },
    );
  });

  group('OfflineAwareDriverRepository — conflict resolution', () {
    test('refreshAfterConflict clears the stale conflict row and re-syncs '
        'the Order from the server', () async {
      final fixture = _Fixture();
      await fixture.queue.enqueue(
        DriverQueueEntry(
          localActionId: 'action-1',
          companyId: fixture.user.companyId,
          driverAccountId: fixture.user.id,
          orderId: 'order-1',
          targetStatus: 'delivered',
          sequence: 1,
          createdAt: DateTime.utc(2026, 8, 9),
          state: DriverSyncRowState.conflict,
        ),
      );
      fixture.api.ordersResult = [_order(status: 'cancelled')];
      final refreshed = await fixture.repository.refreshAfterConflict(
        'order-1',
      );
      expect(refreshed?.status, 'cancelled');
      final rows = await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      );
      expect(rows, isEmpty);
    });

    test('retryFailedEntry deletes the burned key and enqueues a fresh one '
        '— never reusing the old idempotency key', () async {
      final fixture = _Fixture();
      final entry = DriverQueueEntry(
        localActionId: 'burned-key',
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
        targetStatus: 'delivered',
        sequence: 1,
        createdAt: DateTime.utc(2026, 8, 9),
        state: DriverSyncRowState.failed,
      );
      await fixture.queue.enqueue(entry);
      await fixture.repository.retryFailedEntry(
        entry: entry,
        newLocalActionId: 'fresh-key',
      );
      final rows = await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      );
      expect(rows.map((r) => r.localActionId), ['fresh-key']);
      expect(rows.single.state, DriverSyncRowState.pending);
    });
  });
}
