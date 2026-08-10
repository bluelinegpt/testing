import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/services/driver_sync_controller.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/driver_offline_fakes.dart';

final class _SilentLogger implements AppLogger {
  @override
  void info(String event) {}
  @override
  void warning(String event, [Object? error]) {}
  @override
  void error(String event, Object error, StackTrace stack) {}
}

AuthenticatedUser _driver({
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
  String status = 'out_for_delivery',
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
  _Fixture({AuthenticatedUser? user}) : user = user ?? _driver() {
    controller = DriverSyncController(
      api: api,
      cache: cache,
      queue: queue,
      errorMapper: const ApiErrorMapper(),
      logger: _SilentLogger(),
      currentUser: () => this.user,
      onSyncCompleted: () => syncCompletedCalls++,
    )..resume();
  }
  final AuthenticatedUser user;
  final api = ScriptedApiDriverRepository();
  final cache = FakeDriverOfflineCacheRepository();
  final queue = FakeDriverSyncQueueRepository();
  int syncCompletedCalls = 0;
  late final DriverSyncController controller;

  Future<void> seedRow({
    String orderId = 'order-1',
    String localActionId = 'action-1',
    int sequence = 1,
    String targetStatus = 'delivered',
    String? expectedStatus = 'out_for_delivery',
    int retryCount = 0,
    DateTime? nextEligibleAt,
  }) => queue.enqueue(
    DriverQueueEntry(
      localActionId: localActionId,
      companyId: user.companyId,
      driverAccountId: user.id,
      orderId: orderId,
      targetStatus: targetStatus,
      expectedStatus: expectedStatus,
      sequence: sequence,
      createdAt: DateTime.utc(2026, 8, 9),
      state: DriverSyncRowState.pending,
      retryCount: retryCount,
      nextEligibleAt: nextEligibleAt,
    ),
  );
}

void main() {
  test('a paused controller never runs a sync pass', () async {
    final fixture = _Fixture()..controller.pause();
    await fixture.seedRow();
    fixture.api.changeStatusScript.add(_order(status: 'delivered'));
    await fixture.controller.runSyncPass();
    expect(fixture.api.changeStatusCalls, 0);
  });

  test('a non-Driver identity never runs a sync pass', () async {
    final nonDriver = AuthenticatedUser(
      id: 'op-1',
      companyId: 'company-1',
      displayName: 'Op',
      roles: {UserRole.operatorRole},
      permissions: const {},
      accessState: AccountAccessState.active,
    );
    final fixture = _Fixture(user: nonDriver);
    await fixture.seedRow();
    await fixture.controller.runSyncPass();
    expect(fixture.api.changeStatusCalls, 0);
  });

  test('success marks the row synced, writes through the cache, and bumps '
      'the sync-completed signal', () async {
    final fixture = _Fixture();
    await fixture.seedRow();
    fixture.api.changeStatusScript.add(_order(status: 'delivered'));
    await fixture.controller.runSyncPass();
    final rows = await fixture.queue.forOrder(
      companyId: fixture.user.companyId,
      driverAccountId: fixture.user.id,
      orderId: 'order-1',
    );
    expect(rows.single.state, DriverSyncRowState.synced);
    expect(fixture.api.idempotencyKeysUsed.single, 'action-1');
    expect(fixture.api.expectedStatusesUsed.single, 'out_for_delivery');
    final cached = await fixture.cache.cachedOrder(
      companyId: fixture.user.companyId,
      driverAccountId: fixture.user.id,
      orderId: 'order-1',
    );
    expect(cached?.status, 'delivered');
    expect(fixture.syncCompletedCalls, 1);
  });

  test('two queued actions for the same Order replay strictly in sequence — '
      'the second is never attempted before the first completes', () async {
    final fixture = _Fixture();
    await fixture.seedRow(
      localActionId: 'action-1',
      sequence: 1,
      targetStatus: 'out_for_delivery',
      expectedStatus: 'assigned_to_driver',
    );
    await fixture.seedRow(
      localActionId: 'action-2',
      sequence: 2,
      targetStatus: 'delivered',
      expectedStatus: 'out_for_delivery',
    );
    fixture.api.changeStatusScript
      ..add(_order(status: 'out_for_delivery'))
      ..add(_order(status: 'delivered'));
    await fixture.controller.runSyncPass();
    expect(fixture.api.idempotencyKeysUsed, ['action-1', 'action-2']);
    final rows = await fixture.queue.forOrder(
      companyId: fixture.user.companyId,
      driverAccountId: fixture.user.id,
      orderId: 'order-1',
    );
    expect(rows.every((r) => r.state == DriverSyncRowState.synced), isTrue);
  });

  test('different Orders progress independently even when one fails', () async {
    final fixture = _Fixture();
    await fixture.seedRow(orderId: 'order-1', localActionId: 'a1');
    await fixture.seedRow(orderId: 'order-2', localActionId: 'a2');
    // order-1 fails transiently; order-2 succeeds — the API only scripts
    // one outcome globally here, so distinguish via a custom repository
    // wouldn't be needed since each call consumes the next script entry
    // in call order, which is non-deterministic under Future.wait. Seed
    // both entries as retryable network failures instead to keep the
    // assertion order-independent, and confirm order-2 is not blocked by
    // order-1's failure.
    fixture.api.changeStatusScript.add(
      const ApiFailure(ApiFailureKind.network),
    );
    fixture.api.changeStatusScript.add(
      const ApiFailure(ApiFailureKind.network),
    );
    await fixture.controller.runSyncPass();
    final row1 = (await fixture.queue.forOrder(
      companyId: fixture.user.companyId,
      driverAccountId: fixture.user.id,
      orderId: 'order-1',
    )).single;
    final row2 = (await fixture.queue.forOrder(
      companyId: fixture.user.companyId,
      driverAccountId: fixture.user.id,
      orderId: 'order-2',
    )).single;
    expect(row1.state, DriverSyncRowState.pending);
    expect(row1.retryCount, 1);
    expect(row2.state, DriverSyncRowState.pending);
    expect(row2.retryCount, 1);
  });

  group('conflict handling (Prompt 16 §P)', () {
    test('order_status_conflict marks the row conflict, stops this Order\'s '
        'queue, and reconciles from the server', () async {
      final fixture = _Fixture();
      await fixture.seedRow(
        localActionId: 'a1',
        sequence: 1,
        targetStatus: 'delivered',
      );
      await fixture.seedRow(
        localActionId: 'a2',
        sequence: 2,
        targetStatus: 'returned_to_branch',
      );
      fixture.api.changeStatusScript.add(
        const ApiFailure(
          ApiFailureKind.conflict,
          code: 'order_status_conflict',
        ),
      );
      fixture.api.ordersResult = [_order(status: 'cancelled')];
      await fixture.controller.runSyncPass();
      final rows = await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      );
      expect(rows[0].state, DriverSyncRowState.conflict);
      // The second queued action for the same Order was never attempted.
      expect(rows[1].state, DriverSyncRowState.pending);
      expect(fixture.api.changeStatusCalls, 1);
      final cached = await fixture.cache.cachedOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      );
      expect(cached?.status, 'cancelled');
    });

    test('order_status_transition_invalid is treated identically to a '
        'conflict', () async {
      final fixture = _Fixture();
      await fixture.seedRow();
      fixture.api.changeStatusScript.add(
        const ApiFailure(
          ApiFailureKind.conflict,
          code: 'order_status_transition_invalid',
        ),
      );
      await fixture.controller.runSyncPass();
      final rows = await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      );
      expect(rows.single.state, DriverSyncRowState.conflict);
    });

    test(
      'driver_order_access_denied (reassigned) is treated as a conflict',
      () async {
        final fixture = _Fixture();
        await fixture.seedRow();
        fixture.api.changeStatusScript.add(
          const ApiFailure(
            ApiFailureKind.notFound,
            code: 'driver_order_access_denied',
          ),
        );
        await fixture.controller.runSyncPass();
        final rows = await fixture.queue.forOrder(
          companyId: fixture.user.companyId,
          driverAccountId: fixture.user.id,
          orderId: 'order-1',
        );
        expect(rows.single.state, DriverSyncRowState.conflict);
      },
    );

    test('order_not_found is treated as a conflict', () async {
      final fixture = _Fixture();
      await fixture.seedRow();
      fixture.api.changeStatusScript.add(
        const ApiFailure(ApiFailureKind.notFound, code: 'order_not_found'),
      );
      await fixture.controller.runSyncPass();
      final rows = await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      );
      expect(rows.single.state, DriverSyncRowState.conflict);
    });
  });

  test(
    'idempotency_key_reused marks the row failed, never auto-retried',
    () async {
      final fixture = _Fixture();
      await fixture.seedRow();
      fixture.api.changeStatusScript.add(
        const ApiFailure(
          ApiFailureKind.conflict,
          code: 'idempotency_key_reused',
        ),
      );
      await fixture.controller.runSyncPass();
      final rows = await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      );
      expect(rows.single.state, DriverSyncRowState.failed);
      await fixture.controller.runSyncPass();
      // Never picked up again on a subsequent pass — `failed` is terminal
      // until a manual retry re-enqueues a fresh row.
      expect(fixture.api.changeStatusCalls, 1);
    },
  );

  test('a transient network failure stays pending with a bounded backoff, '
      'and is skipped again until it elapses', () async {
    final fixture = _Fixture();
    await fixture.seedRow();
    fixture.api.changeStatusScript.add(
      const ApiFailure(ApiFailureKind.network),
    );
    await fixture.controller.runSyncPass();
    var rows = await fixture.queue.forOrder(
      companyId: fixture.user.companyId,
      driverAccountId: fixture.user.id,
      orderId: 'order-1',
    );
    expect(rows.single.state, DriverSyncRowState.pending);
    expect(rows.single.retryCount, 1);
    expect(rows.single.nextEligibleAt, isNotNull);
    expect(rows.single.nextEligibleAt!.isAfter(DateTime.now().toUtc()), isTrue);

    // A second pass immediately after must not retry yet — backoff not
    // elapsed.
    await fixture.controller.runSyncPass();
    expect(fixture.api.changeStatusCalls, 1);

    // Force the backoff window into the past and retry succeeds.
    await fixture.queue.incrementRetry(
      'action-1',
      nextEligibleAt: DateTime.now().toUtc().subtract(
        const Duration(seconds: 1),
      ),
    );
    fixture.api.changeStatusScript.add(_order(status: 'delivered'));
    await fixture.controller.runSyncPass();
    rows = await fixture.queue.forOrder(
      companyId: fixture.user.companyId,
      driverAccountId: fixture.user.id,
      orderId: 'order-1',
    );
    expect(rows.single.state, DriverSyncRowState.synced);
  });

  test('a 5xx is treated the same as a transient network failure', () async {
    final fixture = _Fixture();
    await fixture.seedRow();
    fixture.api.changeStatusScript.add(const ApiFailure(ApiFailureKind.server));
    await fixture.controller.runSyncPass();
    final rows = await fixture.queue.forOrder(
      companyId: fixture.user.companyId,
      driverAccountId: fixture.user.id,
      orderId: 'order-1',
    );
    expect(rows.single.state, DriverSyncRowState.pending);
    expect(rows.single.retryCount, 1);
  });

  test(
    'a 401 mid-sync stops the entire pass immediately, leaves every '
    'remaining row pending (never failed), and does not touch other Orders',
    () async {
      final fixture = _Fixture();
      await fixture.seedRow(orderId: 'order-1', localActionId: 'a1');
      await fixture.seedRow(orderId: 'order-2', localActionId: 'a2');
      fixture.api.changeStatusScript.add(
        const ApiFailure(ApiFailureKind.unauthorized),
      );
      await fixture.controller.runSyncPass();
      final row1 = (await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-1',
      )).single;
      final row2 = (await fixture.queue.forOrder(
        companyId: fixture.user.companyId,
        driverAccountId: fixture.user.id,
        orderId: 'order-2',
      )).single;
      // Whichever Order's row actually attempted the call ends up reverted
      // to pending with no retry-count bump; the other was simply never
      // attempted (also still pending). Neither is ever `failed`.
      expect(row1.state, DriverSyncRowState.pending);
      expect(row2.state, DriverSyncRowState.pending);
    },
  );
}
