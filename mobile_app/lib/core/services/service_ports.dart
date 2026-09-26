import 'dart:io';

import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/firebase_options.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:package_info_plus/package_info_plus.dart';

abstract interface class AppLogger {
  void info(String event);
  void warning(String event, [Object? error]);
  void error(String event, Object error, StackTrace stack);
}

final class SafeAppLogger implements AppLogger {
  const SafeAppLogger({required this.verbose});
  final bool verbose;

  @override
  void info(String event) {
    if (verbose) debugPrint('[INFO] $event');
  }

  @override
  void warning(String event, [Object? error]) =>
      debugPrint('[WARN] $event ${error?.runtimeType ?? ''}');

  @override
  void error(String event, Object error, StackTrace stack) =>
      debugPrint('[ERROR] $event ${error.runtimeType}');
}

abstract interface class NotificationService {
  Future<void> initialize();
  Future<String?> token();
  Future<void> clearRegistration();
}

abstract interface class DeviceRegistrationService {
  Future<void> register(String token, AuthenticatedUser user);
  Future<void> deregister();
}

final class UnsupportedDeviceRegistrationService
    implements DeviceRegistrationService {
  @override
  Future<void> register(String token, AuthenticatedUser user) => Future.error(
    UnsupportedError('Device registration backend is unavailable'),
  );
  @override
  Future<void> deregister() async {}
}

/// Backs `DeviceRegistrationService` with the real Prompt 15 backend
/// contract: `POST push/device-registrations` (register/refresh a token) and
/// `POST push/device-registrations/deregister` (revoke on logout).
///
/// `SensitiveKey.deviceRegistrationId` is deliberately left unused here — the
/// backend endpoint is an idempotent upsert keyed by `(account, token)`, so
/// there is nothing a locally-cached registration id would let this client
/// skip or short-circuit. `register()` is cheap and safe to call every login
/// and restore (mirroring the existing `_connectOptionalServices` call
/// site), and `deregister()` always revokes every active registration for
/// the account rather than a single tracked id (see below).
final class ApiDeviceRegistrationService implements DeviceRegistrationService {
  ApiDeviceRegistrationService(this.api);
  final ApiClient api;

  @override
  Future<void> register(String token, AuthenticatedUser user) async {
    final platform = _platform();
    // Web/desktop/etc. — mobile push registration only applies to the
    // Android/iOS builds this phase targets.
    if (platform == null) return;
    String? appVersion;
    try {
      appVersion = (await PackageInfo.fromPlatform()).version;
    } on Object {
      // `appVersion` is an optional backend field — a failure to read it
      // (e.g. in a stripped test/CI environment) must never block
      // registration itself.
    }
    await api.post<void>(
      'push/device-registrations',
      data: {
        'platform': platform,
        'token': token,
        if (appVersion != null && appVersion.isNotEmpty)
          'appVersion': appVersion,
      },
    );
  }

  @override
  Future<void> deregister() async {
    // Omitting `token` revokes every active registration for the account —
    // correct on logout, since (per the doc comment above) no single
    // registration id is tracked locally to target instead.
    await api.post<void>('push/device-registrations/deregister');
  }

  static String? _platform() {
    if (kIsWeb) return null;
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    return null;
  }
}

/// Registered via `FirebaseMessaging.onBackgroundMessage` during Firebase
/// init (Android/iOS only). Must be a top-level (or static) function — the
/// platform SDK dispatches it on a separate background isolate with no
/// access to the running app's Riverpod container or widget tree, so it
/// cannot safely read/write app state.
///
/// The backend always sends a `notification` block alongside `data` (see
/// `firebase-push.provider.ts`'s `messaging.send({notification, data})`), so
/// the OS-level notification tray entry while the app is backgrounded or
/// terminated is already handled automatically by the platform FCM SDK —
/// this handler exists only to satisfy the plugin's registration
/// requirement and as a seam for any future background data-only
/// processing, not to construct a UI notification itself.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {}

final class SafeFirebaseNotificationService implements NotificationService {
  SafeFirebaseNotificationService(this.logger);
  final AppLogger logger;
  bool _available = false;

  @override
  Future<void> initialize() async {
    try {
      await Firebase.initializeApp(
        options: DefaultFirebaseOptions.currentPlatform,
      );
      if (!kIsWeb) {
        FirebaseMessaging.onBackgroundMessage(
          firebaseMessagingBackgroundHandler,
        );
      }
      _available = true;
    } on Object catch (error) {
      _available = false;
      logger.warning('notification_configuration_unavailable', error);
    }
  }

  @override
  Future<String?> token() =>
      _available ? FirebaseMessaging.instance.getToken() : Future.value();

  @override
  Future<void> clearRegistration() async {
    if (_available) await FirebaseMessaging.instance.deleteToken();
  }
}

sealed class NotificationDestination {
  const NotificationDestination();
}

final class OrderNotificationDestination extends NotificationDestination {
  const OrderNotificationDestination(this.orderId);
  final String orderId;
}

final class MessageNotificationDestination extends NotificationDestination {
  const MessageNotificationDestination(this.conversationId);
  final String conversationId;
}

final class NotificationCenterDestination extends NotificationDestination {
  const NotificationCenterDestination();
}

/// Parses the shared "where does this notification go" shape used by both
/// an FCM tap (`RemoteMessage.data`) and a Notification Inbox row tap
/// (`{targetType, targetId}` built from a `MobileNotification`) — the single
/// source of truth for push deep-link routing (see Prompt 15 §V).
///
/// `targetType`/`targetId` are never trusted as authorization — they only
/// select which route to navigate to. The destination page's own backend
/// call is what enforces access, exactly as it already does for every other
/// in-app navigation (e.g. `DriverOrderDetailsPage`'s `_load()` returning
/// null for an Order the Driver can no longer see).
abstract final class NotificationRouter {
  static NotificationDestination parse(Map<String, Object?> data) {
    final targetType = data['targetType'];
    final targetId = data['targetId'];
    if (targetType == 'conversation' &&
        targetId is String &&
        targetId.isNotEmpty) {
      return MessageNotificationDestination(targetId);
    }
    if (targetType == 'order' && targetId is String && targetId.isNotEmpty) {
      return OrderNotificationDestination(targetId);
    }
    // No resolvable target (rare — the backend documents `targetId` as
    // nullable) or a malformed payload both fail safe to the Notification
    // Center rather than crashing or silently doing nothing.
    return const NotificationCenterDestination();
  }
}

enum RealtimeState {
  disconnected,
  connecting,
  connected,
  reconnecting,
  offline,
  unauthorized,
  failed,
  suspended,
}

abstract interface class RealtimeClient {
  Stream<RealtimeState> get states;
  Future<void> connect({
    required String accessToken,
    required String companyId,
  });
  Future<void> subscribeToConversation(String conversationId);
  Future<void> disconnect();
}

final class UnsupportedRealtimeClient implements RealtimeClient {
  const UnsupportedRealtimeClient();
  @override
  Stream<RealtimeState> get states => const Stream.empty();
  @override
  Future<void> connect({
    required String accessToken,
    required String companyId,
  }) => Future.error(UnsupportedError('Real-time backend is unavailable'));
  @override
  Future<void> disconnect() async {}
  @override
  Future<void> subscribeToConversation(String conversationId) async {}
}

abstract interface class ConversationRepository {}

abstract interface class MessageRepository {}

abstract interface class VoiceMessageRepository {}

final class ReconnectPolicy {
  const ReconnectPolicy({this.maximumAttempts = 6});
  final int maximumAttempts;
  Duration delayForAttempt(int attempt) {
    final safeAttempt = attempt.clamp(0, maximumAttempts);
    return Duration(seconds: 1 << safeAttempt.clamp(0, 5));
  }
}

abstract interface class OfflineStore {
  Future<void> clearScope({required String userId, required String companyId});
}

abstract interface class ProtectedCache {
  Future<void> write(String companyId, String userId, String key, Object value);
  Future<Object?> read(String companyId, String userId, String key);
  Future<void> clear(String companyId, String userId);
}

final class ScopedMemoryProtectedCache implements ProtectedCache {
  final Map<String, Map<String, Object>> _scopes = {};
  String _scope(String companyId, String userId) => '$companyId::$userId';
  @override
  Future<void> write(
    String companyId,
    String userId,
    String key,
    Object value,
  ) async {
    (_scopes[_scope(companyId, userId)] ??= {})[key] = value;
  }

  @override
  Future<Object?> read(String companyId, String userId, String key) async =>
      _scopes[_scope(companyId, userId)]?[key];
  @override
  Future<void> clear(String companyId, String userId) async {
    _scopes.remove(_scope(companyId, userId));
  }
}

final class PendingAction {
  const PendingAction({
    required this.id,
    required this.userId,
    required this.companyId,
    required this.createdAt,
    required this.idempotencyKey,
  });
  final String id;
  final String userId;
  final String companyId;
  final DateTime createdAt;
  final String idempotencyKey;
}

final class PendingActionQueue {
  final Map<String, PendingAction> _actions = {};
  List<PendingAction> get actions => List.unmodifiable(_actions.values);

  bool enqueue(PendingAction action) {
    if (_actions.containsKey(action.id) ||
        _actions.values.any(
          (existing) => existing.idempotencyKey == action.idempotencyKey,
        )) {
      return false;
    }
    _actions[action.id] = action;
    return true;
  }
}

abstract interface class SyncCoordinator {}

abstract interface class ConflictResolver {}

abstract interface class ConnectivityService {}
