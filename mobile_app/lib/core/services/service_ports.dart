import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

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

final class SafeFirebaseNotificationService implements NotificationService {
  SafeFirebaseNotificationService(this.logger);
  final AppLogger logger;
  bool _available = false;

  @override
  Future<void> initialize() async {
    try {
      await Firebase.initializeApp();
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

abstract final class NotificationRouter {
  static NotificationDestination? parse(Map<String, Object?> data) {
    final type = data['type'];
    final id = data['id'];
    if (type == 'order' && id is String && id.isNotEmpty) {
      return OrderNotificationDestination(id);
    }
    if (type == 'message' && id is String && id.isNotEmpty) {
      return MessageNotificationDestination(id);
    }
    if (type == 'notifications') return const NotificationCenterDestination();
    return null;
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
