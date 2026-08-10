import 'dart:async';

import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/routing/app_router.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Wires the live `PushMessagingCoordinator` streams (token refresh,
/// foreground message, notification tap, terminated-launch tap) to the rest
/// of the app: re-registering the device token, bumping the "refresh from
/// server" signals (Prompt 15 §U), and driving deep-link navigation
/// (Prompt 15 §V) through the same `NotificationRouter` the Notification
/// Inbox uses for a row tap.
///
/// Deliberately a plain class driven by a `Provider` (not a `Notifier`) —
/// there is no UI state to expose, only side effects to perform once for the
/// lifetime of the app. Constructed lazily on first watch (from `app.dart`,
/// inside `_RoutedApp`, which only ever builds once `startupProvider` has
/// resolved) and disposed when the `ProviderContainer` is, via `ref.onDispose`.
final class PushNotificationController {
  PushNotificationController({
    required this.coordinator,
    required this.deviceRegistration,
    required this.ref,
    required this.logger,
  });

  final PushMessagingCoordinator coordinator;
  final DeviceRegistrationService deviceRegistration;
  final Ref ref;
  final AppLogger logger;

  StreamSubscription<String>? _tokenSub;
  StreamSubscription<Map<String, Object?>>? _foregroundSub;
  StreamSubscription<Map<String, Object?>>? _tapSub;
  bool _initialTapChecked = false;

  void start() {
    _tokenSub = coordinator.onTokenRefresh.listen(
      _onTokenRefresh,
      onError: (Object error) =>
          logger.warning('push_token_refresh_handler_error', error),
    );
    _foregroundSub = coordinator.onForegroundMessage.listen(
      _onForegroundMessage,
      onError: (Object error) =>
          logger.warning('push_foreground_handler_error', error),
    );
    _tapSub = coordinator.onNotificationTap.listen(
      _onTap,
      onError: (Object error) =>
          logger.warning('push_tap_handler_error', error),
    );
    unawaited(_checkInitialTap());
  }

  Future<void> _checkInitialTap() async {
    if (_initialTapChecked) return;
    _initialTapChecked = true;
    try {
      final data = await coordinator.initialNotificationTap();
      if (data != null) _onTap(data);
    } on Object catch (error) {
      logger.warning('push_initial_tap_check_failed', error);
    }
  }

  Future<void> _onTokenRefresh(String token) async {
    final user = ref.read(authenticationProvider).value?.user;
    if (user == null) return;
    try {
      await deviceRegistration.register(token, user);
    } on Object catch (error) {
      logger.warning('push_token_refresh_register_failed', error);
    }
  }

  void _onForegroundMessage(Map<String, Object?> data) {
    final notificationType = data['notificationType']?.toString() ?? '';
    switch (refreshScopeFor(notificationType)) {
      case PushRefreshScope.communication:
        ref.read(communicationRefreshSignalProvider.notifier).state++;
      case PushRefreshScope.orders:
        ref.read(ordersRefreshSignalProvider.notifier).state++;
      case PushRefreshScope.none:
        break;
    }
  }

  void _onTap(Map<String, Object?> data) {
    final destination = NotificationRouter.parse(data);
    final router = ref.read(routerProvider);
    switch (destination) {
      case MessageNotificationDestination(:final conversationId):
        router.go('/messages/$conversationId');
      case OrderNotificationDestination(:final orderId):
        router.go('/orders/$orderId');
      case NotificationCenterDestination():
        router.go('/notifications');
    }
  }

  void dispose() {
    unawaited(_tokenSub?.cancel());
    unawaited(_foregroundSub?.cancel());
    unawaited(_tapSub?.cancel());
  }
}

final pushNotificationControllerProvider = Provider<PushNotificationController>(
  (ref) {
    final controller = PushNotificationController(
      coordinator: ref.watch(pushMessagingCoordinatorProvider),
      deviceRegistration: ref.watch(deviceRegistrationProvider),
      ref: ref,
      logger: ref.watch(loggerProvider),
    )..start();
    ref.onDispose(controller.dispose);
    return controller;
  },
);
