import 'dart:async';

import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/reliability/reliability_models.dart'
    show BoundedBackoff;
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_cache_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_sync_queue_repository.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Codes the backend returns for the two "your queued assumption is now
/// stale" cases (Prompt 16 §P Case 2/3) — treated identically: stop
/// replaying further queued actions for that Order, mark this row
/// `conflict`, and reconcile the cache from the server.
const _conflictCodes = {
  'order_status_conflict',
  'order_status_transition_invalid',
  'driver_order_access_denied',
  'order_not_found',
};

/// Codes that only a genuine client bug could produce (Prompt 16 §J) — never
/// auto-retried with the same key.
const _burnedKeyCodes = {
  'idempotency_key_reused',
  'order_status_change_in_progress',
};

/// Drives the Driver offline sync queue's replay logic (Prompt 16 §L/§M):
/// once triggered, replays each Order's queued actions strictly in
/// `sequence` order while different Orders progress independently.
/// Deliberately a plain Dart class with no `Ref`/Riverpod dependency of its
/// own — mirrors the "pure logic the test suite exercises directly"
/// convention already used for `actionsForDriverStatus`/`driverDashboardCards`
/// — so its retry/conflict/backoff/session-expiry behavior is unit-testable
/// against Fakes with no `ProviderContainer` involved. All Riverpod wiring
/// (listening to `offlineProvider`/`authenticationProvider`, bumping the
/// refresh signal) lives in `driverSyncControllerProvider` below.
final class DriverSyncController {
  DriverSyncController({
    required this.api,
    required this.cache,
    required this.queue,
    required this.errorMapper,
    required this.logger,
    required this.currentUser,
    required this.onSyncCompleted,
  });

  /// The plain online repository — replaying a queued row must call the
  /// network directly, never `OfflineAwareDriverRepository.changeStatus`
  /// (which would enqueue a *second* row on failure instead of leaving this
  /// one `pending` for its own backoff).
  final DriverRepository api;
  final DriverOfflineCacheRepository cache;
  final DriverSyncQueueRepository queue;
  final ApiErrorMapper errorMapper;
  final AppLogger logger;

  /// The currently authenticated identity, or `null`/non-Driver if a sync
  /// pass should not run right now.
  final AuthenticatedUser? Function() currentUser;

  /// Called once per pass in which at least one queued row reached a
  /// terminal outcome — bumps the "refresh from the server" hint the Orders
  /// list already listens to (Prompt 16 §C reuse of the Prompt 15 pattern).
  final void Function() onSyncCompleted;

  static const _backoff = BoundedBackoff(
    base: Duration(seconds: 5),
    maximum: Duration(seconds: 300),
  );

  bool _paused = true;
  bool _running = false;
  bool _sessionExpired = false;

  bool get isPaused => _paused;

  void resume() => _paused = false;

  /// Stops sync activity immediately — called before/during logout (Prompt
  /// 16 §T) so a sync pass can never fire against a cache/queue that is
  /// about to be (or has just been) cleared for a different identity.
  void pause() => _paused = true;

  Future<void> runSyncPass() async {
    if (_paused || _running) return;
    final user = currentUser();
    if (user == null || !user.hasRole(UserRole.driver)) return;
    _running = true;
    _sessionExpired = false;
    try {
      final grouped = await queue.pendingGroupedByOrder(
        companyId: user.companyId,
        driverAccountId: user.id,
      );
      if (grouped.isEmpty) return;
      var anyCompleted = false;
      await Future.wait(
        grouped.entries.map((entry) async {
          final completed = await _processOrderQueue(
            entry.key,
            entry.value,
            user,
          );
          if (completed) anyCompleted = true;
        }),
      );
      if (anyCompleted) onSyncCompleted();
    } on Object catch (error) {
      logger.warning('driver_sync_pass_failed', error);
    } finally {
      _running = false;
    }
  }

  /// Returns `true` if at least one row for this Order reached a terminal
  /// outcome (`synced`/`conflict`/`failed`) — used only to decide whether
  /// the orders-refresh signal is worth bumping.
  Future<bool> _processOrderQueue(
    String orderId,
    List<DriverQueueEntry> rows,
    AuthenticatedUser user,
  ) async {
    var completedAny = false;
    for (final row in rows) {
      if (_sessionExpired) return completedAny;
      if (row.nextEligibleAt != null &&
          row.nextEligibleAt!.isAfter(DateTime.now().toUtc())) {
        // Backoff window not elapsed — stop this Order's group for this
        // pass; a later action for the same Order must never jump ahead.
        return completedAny;
      }
      await queue.markSyncing(row.localActionId);
      try {
        final updated = await api.changeStatus(
          row.orderId,
          row.targetStatus,
          row.localActionId,
          reason: row.reason,
          expectedStatus: row.expectedStatus,
        );
        await queue.markSynced(row.localActionId);
        await cache.upsertOrder(
          companyId: user.companyId,
          driverAccountId: user.id,
          order: updated,
          syncedAt: DateTime.now().toUtc(),
        );
        completedAny = true;
      } on Object catch (error) {
        final failure = _failure(error);
        if (failure.kind == ApiFailureKind.unauthorized) {
          // A session-expiry mid-sync is an auth problem, not a business
          // rejection of this row (Prompt 16 §U) — revert it to pending
          // and stop the *entire* pass, not just this Order's group.
          await queue.revertToPending(row.localActionId);
          _sessionExpired = true;
          return completedAny;
        }
        if (_conflictCodes.contains(failure.code)) {
          await queue.markConflict(row.localActionId);
          await _reconcileOrder(orderId, user);
          completedAny = true;
          return completedAny;
        }
        if (_burnedKeyCodes.contains(failure.code)) {
          await queue.markFailed(row.localActionId);
          completedAny = true;
          return completedAny;
        }
        // Transient — still unreachable, or a 5xx. Stays pending with a
        // bounded backoff; other Orders' groups are unaffected.
        final nextRetryCount = row.retryCount + 1;
        await queue.incrementRetry(
          row.localActionId,
          nextEligibleAt: DateTime.now().toUtc().add(
            _backoff.delay(nextRetryCount),
          ),
        );
        return completedAny;
      }
    }
    return completedAny;
  }

  Future<void> _reconcileOrder(String orderId, AuthenticatedUser user) async {
    try {
      final fresh = await api.orders();
      for (final order in fresh) {
        if (order.id == orderId) {
          await cache.upsertOrder(
            companyId: user.companyId,
            driverAccountId: user.id,
            order: order,
            syncedAt: DateTime.now().toUtc(),
          );
          return;
        }
      }
    } on Object catch (error) {
      logger.warning('driver_sync_reconcile_failed', error);
    }
  }

  ApiFailure _failure(Object error) =>
      error is ApiFailure ? error : errorMapper.map(error);
}

final driverSyncControllerProvider = Provider<DriverSyncController>((ref) {
  final controller = DriverSyncController(
    api: ref.watch(driverApiRepositoryProvider),
    cache: ref.watch(driverOfflineCacheRepositoryProvider),
    queue: ref.watch(driverSyncQueueRepositoryProvider),
    errorMapper: const ApiErrorMapper(),
    logger: ref.watch(loggerProvider),
    currentUser: () => ref.read(authenticationProvider).value?.user,
    onSyncCompleted: () =>
        ref.read(ordersRefreshSignalProvider.notifier).state++,
  );
  ref.listen<AsyncValue<bool>>(offlineProvider, (previous, next) {
    // A connectivity event is only ever a trigger to *attempt* a sync
    // pass, never a guarantee — the pass itself decides success/failure per
    // row from the actual HTTP outcome (Prompt 16 §L).
    if (next.value == false) unawaited(controller.runSyncPass());
  });
  ref.listen<AsyncValue<AuthenticationState>>(authenticationProvider, (
    previous,
    next,
  ) {
    final state = next.value;
    if (state != null &&
        state.isAuthenticated &&
        state.user!.hasRole(UserRole.driver)) {
      controller.resume();
      unawaited(controller.runSyncPass());
    } else {
      controller.pause();
    }
  }, fireImmediately: true);
  return controller;
});
