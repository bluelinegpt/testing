import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';

/// Backs `NotificationInboxRepository` (interface defined in
/// `shared/models/mobile_ui_models.dart`, alongside `NotificationPage` and
/// `NotificationInboxController`) with the real Prompt 15 endpoints:
/// `GET push/notifications`, `POST push/notifications/:id/read`, and
/// `POST push/notifications/read-all`.
final class ApiNotificationInboxRepository
    implements NotificationInboxRepository {
  ApiNotificationInboxRepository(this.api);
  final ApiClient api;

  @override
  Future<NotificationPage> page({String? cursor, int limit = 25}) async {
    final data = (await api.getWithQuery<Object?>(
      'push/notifications',
      queryParameters: {'cursor': ?cursor},
    )).data;
    if (data is! Map) throw const ApiFailure(ApiFailureKind.invalidResponse);
    final map = Map<String, dynamic>.from(data);
    final items = map['items'];
    if (items is! List) throw const ApiFailure(ApiFailureKind.invalidResponse);
    return NotificationPage(
      items: [
        for (final item in items)
          if (item is Map) _notification(Map<String, dynamic>.from(item)),
      ],
      nextCursor: map['nextCursor'] as String?,
    );
  }

  @override
  Future<void> markRead(String id) async {
    await api.post<void>('push/notifications/$id/read');
  }

  @override
  Future<void> markAllRead() async {
    await api.post<void>('push/notifications/read-all');
  }

  static MobileNotification _notification(Map<String, dynamic> value) {
    final id = value['id'];
    if (id is! String || id.isEmpty) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    final createdAt =
        DateTime.tryParse(value['createdAt']?.toString() ?? '') ??
        DateTime.now().toUtc();
    final titleKey = value['titleKey'] as String?;
    final bodyParamsRaw = value['bodyParams'];
    return MobileNotification(
      id: id,
      // The UI never displays `.title` verbatim (it resolves `.titleKey` via
      // `titleForNotification` at render time) — this is only a safe,
      // non-empty fallback so the field is never misleadingly blank.
      title: titleKey ?? '',
      createdAt: createdAt,
      isRead: value['readAt'] != null,
      notificationType: value['notificationType']?.toString() ?? '',
      titleKey: titleKey,
      bodyKey: value['bodyKey'] as String?,
      bodyParams: bodyParamsRaw is Map
          ? Map<String, Object?>.from(bodyParamsRaw)
          : const {},
      targetType: value['targetType'] as String?,
      targetId: value['targetId'] as String?,
    );
  }
}
