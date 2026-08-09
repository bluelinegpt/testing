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
  });
  final String id;
  final String title;
  final DateTime createdAt;
  final bool isRead;
  final String? destination;
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
        if (item.id == id)
          MobileNotification(
            id: item.id,
            title: item.title,
            createdAt: item.createdAt,
            isRead: true,
            destination: item.destination,
          )
        else
          item,
    ];
  }

  Future<void> markAllRead() async {
    await repository.markAllRead();
    items = [
      for (final item in items)
        MobileNotification(
          id: item.id,
          title: item.title,
          createdAt: item.createdAt,
          isRead: true,
          destination: item.destination,
        ),
    ];
  }
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
