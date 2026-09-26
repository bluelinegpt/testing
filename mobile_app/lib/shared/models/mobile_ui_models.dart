enum DashboardValueKind { count, currency }

final class DashboardMetric {
  const DashboardMetric({
    required this.key,
    required this.value,
    required this.kind,
  });
  final String key;
  final num? value;
  final DashboardValueKind kind;
}

enum OrderAudience { trader, driver, operatorRole, customer }

final class OrderCardModel {
  const OrderCardModel({
    required this.orderNumber,
    required this.status,
    this.externalReference,
    this.serialNumber,
    this.customerName,
    this.mobileNumber,
    this.emirate,
    this.area,
    this.addressSummary,
    this.cod,
    this.deliveryFee,
    this.netExpected,
    this.assignedDriverName,
  });
  final String orderNumber;
  final String status;
  final String? externalReference;

  /// Display-only — never changes which Orders are fetched or how the list
  /// is scoped/filtered. When present (alongside/instead of
  /// [externalReference]), `OrderCard` shows it as the card's primary,
  /// emphasized identifier and demotes the raw internal [orderNumber] to a
  /// smaller secondary line.
  final String? serialNumber;
  final String? customerName;
  final String? mobileNumber;
  final String? emirate;
  final String? area;
  final String? addressSummary;
  final String? cod;
  final String? deliveryFee;
  final String? netExpected;
  final String? assignedDriverName;
}

enum NotificationLoadState { unavailable, loading, empty, data, error, offline }

final class MobileNotification {
  const MobileNotification({
    required this.id,
    required this.title,
    required this.createdAt,
    required this.isRead,
    this.destination,
    this.notificationType = '',
    this.titleKey,
    this.bodyKey,
    this.bodyParams = const {},
    this.targetType,
    this.targetId,
  });
  final String id;
  final String title;
  final DateTime createdAt;
  final bool isRead;
  final String? destination;

  /// One of `communication.message.created` / `order.assigned` /
  /// `order.reassigned` / `order.status_changed` (Prompt 15 backend
  /// contract) — `''` for any older/unknown fixture that predates it.
  final String notificationType;

  /// Raw localization keys from the backend (e.g.
  /// `push.order.statusChangedTitle`) — resolved to display text at render
  /// time via `titleForNotification`/`bodyForNotification`
  /// (`core/services/push_notifications.dart`), never shown verbatim.
  final String? titleKey;
  final String? bodyKey;
  final Map<String, Object?> bodyParams;

  /// `'conversation'` or `'order'` — together with [targetId], fed straight
  /// into `NotificationRouter.parse` for tap-to-navigate, exactly like an
  /// FCM payload's `targetType`/`targetId`.
  final String? targetType;
  final String? targetId;
}

abstract interface class DashboardRepository {
  Future<List<DashboardMetric>> load();
}

abstract interface class NotificationInboxRepository {
  Future<NotificationPage> page({String? cursor, int limit = 25});
  Future<void> markRead(String id);
  Future<void> markAllRead();
}

final class NotificationPage {
  const NotificationPage({
    required this.items,
    this.nextCursor,
    this.fromCache = false,
  });
  final List<MobileNotification> items;
  final String? nextCursor;
  final bool fromCache;
}

final class NotificationInboxController {
  NotificationInboxController(this.repository);
  final NotificationInboxRepository repository;
  List<MobileNotification> items = [];
  String? nextCursor;
  bool fromCache = false;

  Future<void> load({bool refresh = false}) async {
    final result = await repository.page(cursor: refresh ? null : nextCursor);
    items = refresh ? result.items : [...items, ...result.items];
    nextCursor = result.nextCursor;
    fromCache = result.fromCache;
  }

  Future<void> markRead(String id) async {
    await repository.markRead(id);
    items = [
      for (final item in items)
        if (item.id == id) _markedRead(item) else item,
    ];
  }

  Future<void> markAllRead() async {
    await repository.markAllRead();
    items = [for (final item in items) _markedRead(item)];
  }

  MobileNotification _markedRead(MobileNotification item) => MobileNotification(
    id: item.id,
    title: item.title,
    createdAt: item.createdAt,
    isRead: true,
    destination: item.destination,
    notificationType: item.notificationType,
    titleKey: item.titleKey,
    bodyKey: item.bodyKey,
    bodyParams: item.bodyParams,
    targetType: item.targetType,
    targetId: item.targetId,
  );
}

final class UnsupportedDashboardRepository implements DashboardRepository {
  @override
  Future<List<DashboardMetric>> load() =>
      Future.error(UnsupportedError('Dashboard API unavailable'));
}

final class UnsupportedNotificationInboxRepository
    implements NotificationInboxRepository {
  @override
  Future<NotificationPage> page({String? cursor, int limit = 25}) =>
      Future.error(UnsupportedError('Notification inbox API unavailable'));
  @override
  Future<void> markAllRead() =>
      Future.error(UnsupportedError('Notification inbox API unavailable'));
  @override
  Future<void> markRead(String id) =>
      Future.error(UnsupportedError('Notification inbox API unavailable'));
}
