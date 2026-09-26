import 'dart:math';

enum SyncState {
  draft,
  pending,
  sending,
  confirmed,
  failedRetryable,
  failedPermanent,
  conflict,
  cancelledLocally,
  waitingForAuthentication,
  blockedByDependency,
}

enum OfflineActionType {
  startDelivery,
  markDelivered,
  collectCod,
  deliveryFailure,
  returnReady,
  sendText,
  sendVoice,
  notificationRead,
  conversationRead,
}

enum SyncErrorCategory {
  network,
  timeout,
  backendUnavailable,
  rateLimited,
  authentication,
  forbidden,
  invalidPayload,
  conflict,
  dependency,
  unknown,
}

final class CacheScope {
  const CacheScope({
    required this.environment,
    required this.companyId,
    required this.userId,
    required this.role,
    this.profileId,
  });

  final String environment, companyId, userId, role;
  final String? profileId;

  String get namespace => [
    environment,
    companyId,
    userId,
    role,
    ?profileId,
  ].map(Uri.encodeComponent).join('::');

  bool owns(PendingSyncAction action) => namespace == action.scope.namespace;
}

final class PendingSyncAction {
  const PendingSyncAction({
    required this.clientActionId,
    required this.idempotencyKey,
    required this.scope,
    required this.orderId,
    required this.type,
    required this.payloadVersion,
    required this.originalActionTime,
    required this.localCreationTime,
    this.driverId,
    this.dependencyActionId,
    this.state = SyncState.pending,
    this.retryCount = 0,
    this.lastErrorCategory,
    this.lastAttemptTime,
    this.serverConfirmationId,
  });

  final String clientActionId, idempotencyKey, orderId, payloadVersion;
  final CacheScope scope;
  final String? driverId, dependencyActionId;
  final OfflineActionType type;
  final DateTime originalActionTime, localCreationTime;
  final SyncState state;
  final int retryCount;
  final SyncErrorCategory? lastErrorCategory;
  final DateTime? lastAttemptTime;
  final String? serverConfirmationId;

  PendingSyncAction copyWith({
    SyncState? state,
    int? retryCount,
    SyncErrorCategory? lastErrorCategory,
    DateTime? lastAttemptTime,
    String? serverConfirmationId,
  }) => PendingSyncAction(
    clientActionId: clientActionId,
    idempotencyKey: idempotencyKey,
    scope: scope,
    orderId: orderId,
    type: type,
    payloadVersion: payloadVersion,
    originalActionTime: originalActionTime,
    localCreationTime: localCreationTime,
    driverId: driverId,
    dependencyActionId: dependencyActionId,
    state: state ?? this.state,
    retryCount: retryCount ?? this.retryCount,
    lastErrorCategory: lastErrorCategory ?? this.lastErrorCategory,
    lastAttemptTime: lastAttemptTime ?? this.lastAttemptTime,
    serverConfirmationId: serverConfirmationId ?? this.serverConfirmationId,
  );
}

final class PendingSyncQueue {
  final Map<String, PendingSyncAction> _actions = {};

  List<PendingSyncAction> forScope(CacheScope scope) =>
      _actions.values.where(scope.owns).toList(growable: false)
        ..sort((a, b) => a.localCreationTime.compareTo(b.localCreationTime));

  bool enqueue(PendingSyncAction action) {
    if (_actions.containsKey(action.clientActionId) ||
        _actions.values.any(
          (item) =>
              item.scope.namespace == action.scope.namespace &&
              item.idempotencyKey == action.idempotencyKey,
        )) {
      return false;
    }
    _actions[action.clientActionId] = action;
    return true;
  }

  PendingSyncAction? find(String id) => _actions[id];

  void replace(PendingSyncAction action) {
    if (_actions.containsKey(action.clientActionId)) {
      _actions[action.clientActionId] = action;
    }
  }

  void clearScope(CacheScope scope) =>
      _actions.removeWhere((_, action) => scope.owns(action));

  List<PendingSyncAction> ready(CacheScope scope) => forScope(scope)
      .where((a) {
        if (a.state != SyncState.pending &&
            a.state != SyncState.failedRetryable) {
          return false;
        }
        final dependency = a.dependencyActionId == null
            ? null
            : _actions[a.dependencyActionId];
        return dependency == null || dependency.state == SyncState.confirmed;
      })
      .toList(growable: false);
}

enum SyncResultKind { confirmed, retryableFailure, permanentFailure, conflict }

final class SyncResult {
  const SyncResult(this.kind, {this.confirmationId, this.errorCategory});
  final SyncResultKind kind;
  final String? confirmationId;
  final SyncErrorCategory? errorCategory;
}

abstract interface class SyncActionExecutor {
  Future<SyncResult> execute(PendingSyncAction action);
}

final class ReliableSyncCoordinator {
  ReliableSyncCoordinator(this.queue, this.executor, {this.maximumRetries = 5});
  final PendingSyncQueue queue;
  final SyncActionExecutor executor;
  final int maximumRetries;
  bool _running = false;

  bool get isRunning => _running;

  Future<bool> synchronize(CacheScope scope, {required bool authorized}) async {
    if (_running) return false;
    _running = true;
    try {
      if (!authorized) {
        for (final action in queue.forScope(scope)) {
          if (action.state == SyncState.pending ||
              action.state == SyncState.failedRetryable) {
            queue.replace(
              action.copyWith(state: SyncState.waitingForAuthentication),
            );
          }
        }
        return false;
      }
      for (final action in queue.ready(scope)) {
        queue.replace(
          action.copyWith(
            state: SyncState.sending,
            lastAttemptTime: DateTime.now().toUtc(),
          ),
        );
        final result = await executor.execute(action);
        final current = queue.find(action.clientActionId)!;
        switch (result.kind) {
          case SyncResultKind.confirmed:
            queue.replace(
              current.copyWith(
                state: SyncState.confirmed,
                serverConfirmationId: result.confirmationId,
              ),
            );
          case SyncResultKind.retryableFailure:
            final retries = current.retryCount + 1;
            queue.replace(
              current.copyWith(
                retryCount: retries,
                state: retries >= maximumRetries
                    ? SyncState.failedPermanent
                    : SyncState.failedRetryable,
                lastErrorCategory:
                    result.errorCategory ?? SyncErrorCategory.unknown,
              ),
            );
          case SyncResultKind.permanentFailure:
            queue.replace(
              current.copyWith(
                state: SyncState.failedPermanent,
                lastErrorCategory:
                    result.errorCategory ?? SyncErrorCategory.unknown,
              ),
            );
          case SyncResultKind.conflict:
            queue.replace(
              current.copyWith(
                state: SyncState.conflict,
                lastErrorCategory: SyncErrorCategory.conflict,
              ),
            );
        }
      }
      _markBlockedDependencies(scope);
      return true;
    } finally {
      _running = false;
    }
  }

  void _markBlockedDependencies(CacheScope scope) {
    for (final action in queue.forScope(scope)) {
      final dependency = action.dependencyActionId == null
          ? null
          : queue.find(action.dependencyActionId!);
      if (dependency != null &&
          (dependency.state == SyncState.failedPermanent ||
              dependency.state == SyncState.conflict)) {
        queue.replace(
          action.copyWith(
            state: SyncState.blockedByDependency,
            lastErrorCategory: SyncErrorCategory.dependency,
          ),
        );
      }
    }
  }
}

final class BoundedDeduplicator {
  BoundedDeduplicator({this.capacity = 200});
  final int capacity;
  final List<String> _order = [];
  final Set<String> _ids = {};

  bool accept(String stableServerId) {
    if (stableServerId.isEmpty || !_ids.add(stableServerId)) return false;
    _order.add(stableServerId);
    while (_order.length > capacity) {
      _ids.remove(_order.removeAt(0));
    }
    return true;
  }
}

enum ReliableConnectionState {
  disconnected,
  connecting,
  connected,
  reconnecting,
  offline,
  unauthorized,
  failed,
  suspended,
}

final class EventCursor {
  String? _confirmed;
  final BoundedDeduplicator _events = BoundedDeduplicator(capacity: 500);
  String? get confirmed => _confirmed;

  bool confirm({required String eventId, required String cursor}) {
    if (!_events.accept(eventId)) return false;
    _confirmed = cursor;
    return true;
  }
}

final class BoundedBackoff {
  const BoundedBackoff({
    this.base = const Duration(seconds: 1),
    this.maximum = const Duration(minutes: 2),
  });
  final Duration base, maximum;

  Duration delay(int attempt, {Random? random}) {
    final exponent = attempt.clamp(0, 10);
    final raw = min(
      maximum.inMilliseconds,
      base.inMilliseconds * (1 << exponent),
    );
    final jitter = (random ?? Random()).nextInt(max(1, raw ~/ 4));
    return Duration(milliseconds: min(maximum.inMilliseconds, raw + jitter));
  }
}

String maskPushToken(String token) {
  if (token.length < 8) return '***';
  return '${token.substring(0, 4)}…${token.substring(token.length - 4)}';
}
