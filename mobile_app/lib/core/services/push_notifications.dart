import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
// `StateProvider` moved to this separate entrypoint in Riverpod 3 — the main
// `flutter_riverpod.dart` barrel no longer re-exports it.
import 'package:flutter_riverpod/legacy.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

/// Deliberately narrower than `firebase_messaging`'s own
/// `AuthorizationStatus` — `provisional` (iOS-only, quiet delivery) counts as
/// authorized for this app's purposes, and every caller only ever needs to
/// know "can we show notifications" vs "not yet" vs "no".
enum NotificationPermissionState { authorized, denied, notDetermined }

/// The Firebase/OS-integration surface `NotificationService` (init/token/
/// clear — used by the Login/restore/logout flow) deliberately does not
/// cover: permission UX, foreground/background/terminated message delivery,
/// and token-refresh notice. Kept as a sibling service (not folded into
/// `NotificationService`) so the existing auth-flow tests and fakes never
/// need to change shape for Prompt 15.
///
/// Every stream/method is safe-by-construction: a missing/misconfigured
/// Firebase project must degrade to "push unavailable", never throw into
/// caller code.
abstract interface class PushMessagingCoordinator {
  Future<NotificationPermissionState> permissionStatus();
  Future<NotificationPermissionState> requestPermission();

  /// `true` only when the OS has permanently suppressed the permission
  /// prompt (Android "don't ask again" / iOS after a first denial) — the
  /// only case where "Open Settings" is the sole way forward.
  Future<bool> isPermanentlyDenied();
  Future<bool> openSettings();

  /// A fresh FCM token whenever the platform SDK rotates it — every event
  /// must be re-registered with the backend (see `PushNotificationController`).
  Stream<String> get onTokenRefresh;

  /// The `data` payload of every push received while the app is in the
  /// foreground (`FirebaseMessaging.onMessage`).
  Stream<Map<String, Object?>> get onForegroundMessage;

  /// The `data` payload of a notification tap that (re)opened the app from
  /// the background (`FirebaseMessaging.onMessageOpenedApp`).
  Stream<Map<String, Object?>> get onNotificationTap;

  /// The `data` payload of the notification tap that launched the app from
  /// terminated, if any (`FirebaseMessaging.instance.getInitialMessage()`).
  Future<Map<String, Object?>?> initialNotificationTap();
}

final class UnsupportedPushMessagingCoordinator
    implements PushMessagingCoordinator {
  const UnsupportedPushMessagingCoordinator();
  @override
  Future<NotificationPermissionState> permissionStatus() async =>
      NotificationPermissionState.notDetermined;
  @override
  Future<NotificationPermissionState> requestPermission() async =>
      NotificationPermissionState.notDetermined;
  @override
  Future<bool> isPermanentlyDenied() async => false;
  @override
  Future<bool> openSettings() async => false;
  @override
  Stream<String> get onTokenRefresh => const Stream.empty();
  @override
  Stream<Map<String, Object?>> get onForegroundMessage => const Stream.empty();
  @override
  Stream<Map<String, Object?>> get onNotificationTap => const Stream.empty();
  @override
  Future<Map<String, Object?>?> initialNotificationTap() async => null;
}

final class FirebasePushMessagingCoordinator
    implements PushMessagingCoordinator {
  FirebasePushMessagingCoordinator(this.logger);
  final AppLogger logger;

  @override
  Future<NotificationPermissionState> permissionStatus() async {
    try {
      final settings = await FirebaseMessaging.instance
          .getNotificationSettings();
      return _map(settings.authorizationStatus);
    } on Object catch (error) {
      logger.warning('push_permission_status_unavailable', error);
      return NotificationPermissionState.notDetermined;
    }
  }

  @override
  Future<NotificationPermissionState> requestPermission() async {
    try {
      final settings = await FirebaseMessaging.instance.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );
      return _map(settings.authorizationStatus);
    } on Object catch (error) {
      logger.warning('push_permission_request_failed', error);
      return NotificationPermissionState.denied;
    }
  }

  @override
  Future<bool> isPermanentlyDenied() async {
    try {
      final status = await ph.Permission.notification.status;
      return status == ph.PermissionStatus.permanentlyDenied;
    } on Object catch (error) {
      logger.warning('push_permission_status_check_failed', error);
      return false;
    }
  }

  @override
  Future<bool> openSettings() async {
    try {
      return await ph.openAppSettings();
    } on Object catch (error) {
      logger.warning('push_open_settings_failed', error);
      return false;
    }
  }

  @override
  Stream<String> get onTokenRefresh =>
      FirebaseMessaging.instance.onTokenRefresh.handleError(
        (Object error) =>
            logger.warning('push_token_refresh_stream_error', error),
      );

  @override
  Stream<Map<String, Object?>> get onForegroundMessage => FirebaseMessaging
      .onMessage
      .map((message) => message.data)
      .handleError(
        (Object error) => logger.warning('push_foreground_stream_error', error),
      );

  @override
  Stream<Map<String, Object?>> get onNotificationTap => FirebaseMessaging
      .onMessageOpenedApp
      .map((message) => message.data)
      .handleError(
        (Object error) => logger.warning('push_tap_stream_error', error),
      );

  @override
  Future<Map<String, Object?>?> initialNotificationTap() async {
    try {
      return (await FirebaseMessaging.instance.getInitialMessage())?.data;
    } on Object catch (error) {
      logger.warning('push_initial_message_unavailable', error);
      return null;
    }
  }

  static NotificationPermissionState _map(AuthorizationStatus status) =>
      switch (status) {
        AuthorizationStatus.authorized || AuthorizationStatus.provisional =>
          NotificationPermissionState.authorized,
        AuthorizationStatus.denied => NotificationPermissionState.denied,
        AuthorizationStatus.notDetermined =>
          NotificationPermissionState.notDetermined,
      };
}

/// What a foreground push should do to the UI — always "go re-fetch the
/// truth from the server", never an independent counter increment. This is
/// what keeps a WebSocket-delivered and an FCM-delivered notice of the same
/// underlying event from ever double-counting: neither path increments
/// anything directly, both just signal "refresh from REST" (Prompt 15 §U).
enum PushRefreshScope { none, communication, orders }

PushRefreshScope refreshScopeFor(String notificationType) {
  if (notificationType == 'communication.message.created') {
    return PushRefreshScope.communication;
  }
  if (notificationType.startsWith('order.')) return PushRefreshScope.orders;
  return PushRefreshScope.none;
}

/// Bumped by `PushNotificationController` whenever a foreground push implies
/// "the Communication inbox/unread state may be stale" — pages that show
/// that data listen for a change and re-fetch from REST. Never read as a
/// counter of anything itself.
final communicationRefreshSignalProvider = StateProvider<int>((ref) => 0);

/// Same idea as [communicationRefreshSignalProvider], for Order-related
/// lists (Driver Orders, Driver Dashboard, Trader Orders, …).
final ordersRefreshSignalProvider = StateProvider<int>((ref) => 0);

/// Pure, one-source-of-truth mapping from a backend `titleKey` to display
/// text — used identically by the Notification Inbox list and any
/// foreground-push banner, mirroring the `driverDashboardCards`-style "pure
/// function the test suite exercises directly" convention.
String titleForNotification(String? titleKey, AppLocalizations l10n) =>
    switch (titleKey) {
      'push.communication.newMessageTitle' => l10n.newMessageNotification,
      'push.order.assignedTitle' => l10n.orderAssignedNotification,
      'push.order.reassignedTitle' => l10n.orderReassignedNotification,
      'push.order.statusChangedTitle' => l10n.orderUpdatedNotification,
      _ => l10n.notifications,
    };

/// Pure mapping for the body line. `bodyKey` covers the Communication
/// notifications; Order notifications carry no `bodyKey` from the backend
/// (see Prompt 15 contract) and are instead formatted from `bodyParams`
/// (e.g. `{status: "delivered"}`) reusing the existing `OrderStatusMapper`
/// status labels — the same labels already shown everywhere else in the app.
String? bodyForNotification({
  required String notificationType,
  required String? bodyKey,
  required Map<String, Object?> bodyParams,
  required AppLocalizations l10n,
}) {
  switch (bodyKey) {
    case 'push.communication.newTextMessageBody':
      return l10n.newMessageNotification;
    case 'push.communication.newVoiceMessageBody':
      return l10n.voiceMessageNotification;
  }
  if (notificationType == 'order.status_changed') {
    final status = bodyParams['status']?.toString();
    if (status != null && status.isNotEmpty) {
      return OrderStatusMapper.label(OrderStatusMapper.parse(status), l10n);
    }
  }
  return null;
}
