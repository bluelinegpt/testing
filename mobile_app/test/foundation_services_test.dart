import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('API errors map standardized status and correlation ID', () {
    final response = Response<Object?>(
      requestOptions: RequestOptions(),
      statusCode: 403,
      data: {
        'error': {'code': 'authorization_error', 'correlationId': 'test-id'},
      },
    );
    final failure = const ApiErrorMapper().map(
      DioException(requestOptions: RequestOptions(), response: response),
    );
    expect(failure.kind, ApiFailureKind.forbidden);
    expect(failure.correlationId, 'test-id');
  });

  test('protected cache is isolated by Company and User', () async {
    final cache = ScopedMemoryProtectedCache();
    await cache.write('company-a', 'user-a', 'orders', 'private-a');
    expect(await cache.read('company-a', 'user-a', 'orders'), 'private-a');
    expect(await cache.read('company-a', 'user-b', 'orders'), isNull);
    expect(await cache.read('company-b', 'user-a', 'orders'), isNull);
    await cache.clear('company-a', 'user-a');
    expect(await cache.read('company-a', 'user-a', 'orders'), isNull);
  });

  test('offline queue rejects duplicate IDs and idempotency keys', () {
    final queue = PendingActionQueue();
    final action = PendingAction(
      id: 'one',
      userId: 'user',
      companyId: 'company',
      createdAt: DateTime.utc(2026),
      idempotencyKey: 'stable-key',
    );
    expect(queue.enqueue(action), isTrue);
    expect(queue.enqueue(action), isFalse);
    expect(
      queue.enqueue(
        PendingAction(
          id: 'two',
          userId: 'user',
          companyId: 'company',
          createdAt: DateTime.utc(2026),
          idempotencyKey: 'stable-key',
        ),
      ),
      isFalse,
    );
  });

  test('notification deep links parse the targetType/targetId contract and '
      'reject malformed payloads by falling back to the Notification Center '
      '(never null, never a crash)', () {
    expect(
      NotificationRouter.parse({'targetType': 'order', 'targetId': 'order-1'}),
      isA<OrderNotificationDestination>(),
    );
    expect(
      NotificationRouter.parse({
        'targetType': 'conversation',
        'targetId': 'conversation-1',
      }),
      isA<MessageNotificationDestination>(),
    );
    expect(
      NotificationRouter.parse({'targetType': 'order', 'targetId': ''}),
      isA<NotificationCenterDestination>(),
    );
    expect(
      NotificationRouter.parse({'targetType': 'unknown'}),
      isA<NotificationCenterDestination>(),
    );
    expect(
      NotificationRouter.parse(const {}),
      isA<NotificationCenterDestination>(),
    );
  });

  test('real-time reconnect backoff is deterministic and capped', () {
    const policy = ReconnectPolicy(maximumAttempts: 6);
    expect(policy.delayForAttempt(0), const Duration(seconds: 1));
    expect(policy.delayForAttempt(3), const Duration(seconds: 8));
    expect(policy.delayForAttempt(99), const Duration(seconds: 32));
  });
}
