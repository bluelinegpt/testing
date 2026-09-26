import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('notification inbox paginates and marks read', () async {
    final repository = _FakeInbox();
    final controller = NotificationInboxController(repository);
    await controller.load(refresh: true);
    expect(controller.items, hasLength(1));
    expect(controller.nextCursor, 'next');
    await controller.load();
    expect(controller.items, hasLength(2));
    await controller.markRead('one');
    expect(controller.items.first.isRead, isTrue);
    await controller.markAllRead();
    expect(controller.items.every((item) => item.isRead), isTrue);
  });

  test('offline cached notification state is explicit', () async {
    final repository = _FakeInbox()..offline = true;
    final controller = NotificationInboxController(repository);
    await controller.load(refresh: true);
    expect(controller.fromCache, isTrue);
  });
}

final class _FakeInbox implements NotificationInboxRepository {
  int calls = 0;
  bool offline = false;
  @override
  Future<NotificationPage> page({String? cursor, int limit = 25}) async {
    calls++;
    return NotificationPage(
      items: [
        MobileNotification(
          id: calls == 1 ? 'one' : 'two',
          title: 'Safe title',
          createdAt: DateTime.utc(2026),
          isRead: false,
        ),
      ],
      nextCursor: calls == 1 ? 'next' : null,
      fromCache: offline,
    );
  }

  @override
  Future<void> markAllRead() async {}
  @override
  Future<void> markRead(String id) async {}
}
