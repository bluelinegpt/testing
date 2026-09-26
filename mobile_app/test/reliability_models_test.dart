import 'dart:math';

import 'package:bluelinegpt_mobile/core/reliability/reliability_models.dart';
import 'package:flutter_test/flutter_test.dart';

const scope = CacheScope(
  environment: 'development',
  companyId: 'company-a',
  userId: 'user-a',
  role: 'driver',
  profileId: 'driver-a',
);

PendingSyncAction action(
  String id, {
  String? key,
  String? dependency,
  CacheScope actionScope = scope,
  OfflineActionType type = OfflineActionType.startDelivery,
}) => PendingSyncAction(
  clientActionId: id,
  idempotencyKey: key ?? 'key-$id',
  scope: actionScope,
  orderId: 'order-1',
  type: type,
  payloadVersion: '1',
  originalActionTime: DateTime.utc(2026),
  localCreationTime: DateTime.utc(2026),
  dependencyActionId: dependency,
);

final class FakeExecutor implements SyncActionExecutor {
  FakeExecutor(this.results);
  final List<SyncResult> results;
  final List<String> calls = [];
  @override
  Future<SyncResult> execute(PendingSyncAction action) async {
    calls.add(action.clientActionId);
    return results.removeAt(0);
  }
}

void main() {
  test(
    'cache namespace isolates environment, Company, user, role, profile',
    () {
      const other = CacheScope(
        environment: 'production',
        companyId: 'company-a',
        userId: 'user-a',
        role: 'driver',
        profileId: 'driver-a',
      );
      expect(scope.namespace, isNot(other.namespace));
      expect(scope.owns(action('a')), isTrue);
      expect(other.owns(action('a')), isFalse);
    },
  );

  test('duplicate action and idempotency key are rejected within scope', () {
    final queue = PendingSyncQueue();
    expect(queue.enqueue(action('a')), isTrue);
    expect(queue.enqueue(action('a')), isFalse);
    expect(queue.enqueue(action('b', key: 'key-a')), isFalse);
  });

  test('same idempotency key cannot leak across account scope', () {
    final queue = PendingSyncQueue();
    const other = CacheScope(
      environment: 'development',
      companyId: 'company-a',
      userId: 'user-b',
      role: 'driver',
    );
    expect(queue.enqueue(action('a')), isTrue);
    expect(
      queue.enqueue(action('b', key: 'key-a', actionScope: other)),
      isTrue,
    );
    expect(queue.forScope(scope), hasLength(1));
    expect(queue.forScope(other), hasLength(1));
  });

  test('dependency is sent only after prerequisite is confirmed', () async {
    final queue = PendingSyncQueue()
      ..enqueue(action('start'))
      ..enqueue(action('cod', dependency: 'start'));
    final executor = FakeExecutor([
      const SyncResult(SyncResultKind.confirmed, confirmationId: 'server-1'),
    ]);
    await ReliableSyncCoordinator(
      queue,
      executor,
    ).synchronize(scope, authorized: true);
    expect(executor.calls, ['start']);
    expect(queue.find('start')!.state, SyncState.confirmed);
    expect(queue.find('cod')!.state, SyncState.pending);
  });

  test('conflict is visible and blocks dependent financial action', () async {
    final queue = PendingSyncQueue()
      ..enqueue(action('delivered'))
      ..enqueue(
        action(
          'cod',
          dependency: 'delivered',
          type: OfflineActionType.collectCod,
        ),
      );
    final executor = FakeExecutor([const SyncResult(SyncResultKind.conflict)]);
    await ReliableSyncCoordinator(
      queue,
      executor,
    ).synchronize(scope, authorized: true);
    expect(queue.find('delivered')!.state, SyncState.conflict);
    expect(queue.find('cod')!.state, SyncState.blockedByDependency);
  });

  test('session expiry stops processing without discarding action', () async {
    final queue = PendingSyncQueue()..enqueue(action('a'));
    final executor = FakeExecutor([]);
    final result = await ReliableSyncCoordinator(
      queue,
      executor,
    ).synchronize(scope, authorized: false);
    expect(result, isFalse);
    expect(executor.calls, isEmpty);
    expect(queue.find('a')!.state, SyncState.waitingForAuthentication);
  });

  test('retry keeps idempotency key and becomes permanent at bound', () async {
    final queue = PendingSyncQueue()..enqueue(action('a'));
    final executor = FakeExecutor([
      const SyncResult(
        SyncResultKind.retryableFailure,
        errorCategory: SyncErrorCategory.timeout,
      ),
    ]);
    await ReliableSyncCoordinator(
      queue,
      executor,
      maximumRetries: 1,
    ).synchronize(scope, authorized: true);
    expect(queue.find('a')!.idempotencyKey, 'key-a');
    expect(queue.find('a')!.state, SyncState.failedPermanent);
  });

  test('notification and event IDs are bounded and deduplicated', () {
    final dedupe = BoundedDeduplicator(capacity: 2);
    expect(dedupe.accept('n1'), isTrue);
    expect(dedupe.accept('n1'), isFalse);
    expect(dedupe.accept('n2'), isTrue);
    expect(dedupe.accept('n3'), isTrue);
    expect(dedupe.accept('n1'), isTrue);
    expect(dedupe.accept(''), isFalse);
  });

  test('cursor advances only for a new event', () {
    final cursor = EventCursor();
    expect(cursor.confirm(eventId: 'e1', cursor: '10'), isTrue);
    expect(cursor.confirm(eventId: 'e1', cursor: '11'), isFalse);
    expect(cursor.confirmed, '10');
  });

  test('backoff is bounded and token diagnostics are masked', () {
    const policy = BoundedBackoff(maximum: Duration(seconds: 10));
    expect(
      policy.delay(20, random: Random(1)),
      lessThanOrEqualTo(const Duration(seconds: 10)),
    );
    expect(maskPushToken('abcdefghijkl'), 'abcd…ijkl');
    expect(maskPushToken('short'), '***');
  });

  test('clearing one scope preserves another account queue', () {
    final queue = PendingSyncQueue()..enqueue(action('a'));
    const other = CacheScope(
      environment: 'development',
      companyId: 'company-a',
      userId: 'user-b',
      role: 'driver',
    );
    queue.enqueue(action('b', actionScope: other));
    queue.clearScope(scope);
    expect(queue.forScope(scope), isEmpty);
    expect(queue.forScope(other), hasLength(1));
  });
}
