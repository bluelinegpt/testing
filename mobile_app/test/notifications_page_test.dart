import 'dart:async';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';
import 'package:bluelinegpt_mobile/features/notifications/notifications_page.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

/// In-memory double for `NotificationInboxRepository` — mirrors
/// `_FakeInbox` in `test/notification_inbox_test.dart` but configurable
/// enough to exercise the full page (errors, pagination, extended fields).
final class _FakeInboxRepository implements NotificationInboxRepository {
  List<MobileNotification> firstPageItems = const [];
  String? firstPageNextCursor;
  Object? pageError;
  int markReadCalls = 0;
  int markAllReadCalls = 0;
  final List<String> markReadIds = [];

  /// When set, the first-page `page()` call awaits this instead of
  /// resolving immediately — lets a test hold the "loading" state open
  /// deterministically (a plain `async` return with no real delay can
  /// resolve before the test's very next `pump()`, per Dart's microtask
  /// scheduling, making the loading state otherwise unobservable).
  Completer<NotificationPage>? pendingFirstPage;

  @override
  Future<NotificationPage> page({String? cursor, int limit = 25}) async {
    if (pageError != null) throw pageError!;
    if (cursor == null) {
      if (pendingFirstPage != null) return pendingFirstPage!.future;
      return NotificationPage(
        items: firstPageItems,
        nextCursor: firstPageNextCursor,
      );
    }
    return const NotificationPage(items: [], nextCursor: null);
  }

  @override
  Future<void> markRead(String id) async {
    markReadCalls += 1;
    markReadIds.add(id);
  }

  @override
  Future<void> markAllRead() async {
    markAllReadCalls += 1;
  }
}

/// A `PushMessagingCoordinator` double that reports "already authorized" by
/// default so `NotificationPermissionBanner` renders nothing and the tests
/// below can focus purely on the inbox list itself.
final class _FakeCoordinator implements PushMessagingCoordinator {
  NotificationPermissionState statusResult =
      NotificationPermissionState.authorized;
  NotificationPermissionState requestResult =
      NotificationPermissionState.authorized;
  bool permanentlyDeniedResult = false;

  @override
  Future<NotificationPermissionState> permissionStatus() async => statusResult;
  @override
  Future<NotificationPermissionState> requestPermission() async =>
      requestResult;
  @override
  Future<bool> isPermanentlyDenied() async => permanentlyDeniedResult;
  @override
  Future<bool> openSettings() async => true;
  @override
  Stream<String> get onTokenRefresh => const Stream.empty();
  @override
  Stream<Map<String, Object?>> get onForegroundMessage => const Stream.empty();
  @override
  Stream<Map<String, Object?>> get onNotificationTap => const Stream.empty();
  @override
  Future<Map<String, Object?>?> initialNotificationTap() async => null;
}

MobileNotification _item({
  required String id,
  bool isRead = false,
  String notificationType = 'order.status_changed',
  String? titleKey = 'push.order.statusChangedTitle',
  Map<String, Object?> bodyParams = const {'status': 'delivered'},
  String? targetType,
  String? targetId,
}) => MobileNotification(
  id: id,
  title: titleKey ?? '',
  createdAt: DateTime.utc(2026, 8, 9, 10),
  isRead: isRead,
  notificationType: notificationType,
  titleKey: titleKey,
  bodyParams: bodyParams,
  targetType: targetType,
  targetId: targetId,
);

Widget _wrap(
  Widget child, {
  required _FakeInboxRepository repository,
  _FakeCoordinator? coordinator,
  Locale locale = const Locale('en'),
}) => ProviderScope(
  overrides: [
    notificationInboxRepositoryProvider.overrideWithValue(repository),
    pushMessagingCoordinatorProvider.overrideWithValue(
      coordinator ?? _FakeCoordinator(),
    ),
    storageProvider.overrideWithValue(MemorySensitiveStorage()),
  ],
  child: MaterialApp(
    locale: locale,
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: const [
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: Scaffold(body: child),
  ),
);

void main() {
  group('NotificationsPage — loading/empty/error', () {
    testWidgets('shows a loading skeleton before the first page resolves', (
      tester,
    ) async {
      final completer = Completer<NotificationPage>();
      final repository = _FakeInboxRepository()..pendingFirstPage = completer;
      await tester.pumpWidget(
        _wrap(const NotificationsPage(), repository: repository),
      );
      await tester.pump();
      expect(find.byType(DashboardSkeleton), findsOneWidget);
      completer.complete(NotificationPage(items: [_item(id: '1')]));
      await tester.pumpAndSettle();
      expect(find.byType(DashboardSkeleton), findsNothing);
    });

    testWidgets('shows the empty state when there are no notifications', (
      tester,
    ) async {
      final repository = _FakeInboxRepository();
      await tester.pumpWidget(
        _wrap(const NotificationsPage(), repository: repository),
      );
      await tester.pumpAndSettle();
      expect(find.text('No notifications'), findsOneWidget);
    });

    testWidgets('shows a retryable error state, and retry recovers', (
      tester,
    ) async {
      final repository = _FakeInboxRepository()..pageError = Exception('boom');
      await tester.pumpWidget(
        _wrap(const NotificationsPage(), repository: repository),
      );
      await tester.pumpAndSettle();
      expect(find.byType(AppErrorState), findsOneWidget);
      repository.pageError = null;
      repository.firstPageItems = [_item(id: '1')];
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(find.byType(AppErrorState), findsNothing);
      expect(find.byType(ListTile), findsOneWidget);
    });
  });

  group('NotificationsPage — unread indicator and mark read', () {
    testWidgets(
      'a mixed read/unread fixture list shows the unread indicator only on '
      'unread rows',
      (tester) async {
        final repository = _FakeInboxRepository()
          ..firstPageItems = [
            _item(id: 'read-1', isRead: true),
            _item(id: 'unread-1'),
          ];
        await tester.pumpWidget(
          _wrap(const NotificationsPage(), repository: repository),
        );
        await tester.pumpAndSettle();
        expect(find.byIcon(Icons.circle), findsOneWidget);
      },
    );

    testWidgets(
      'tapping an unread notification marks it read via the repository and '
      'the UI drops the unread indicator',
      (tester) async {
        final repository = _FakeInboxRepository()
          ..firstPageItems = [_item(id: 'unread-1')];
        await tester.pumpWidget(
          _wrap(const NotificationsPage(), repository: repository),
        );
        await tester.pumpAndSettle();
        expect(find.byIcon(Icons.circle), findsOneWidget);
        await tester.tap(find.byType(ListTile));
        await tester.pumpAndSettle();
        expect(repository.markReadCalls, 1);
        expect(repository.markReadIds, ['unread-1']);
        expect(find.byIcon(Icons.circle), findsNothing);
      },
    );

    testWidgets(
      'Mark all as read marks every item read via the repository in one '
      'bulk call and the UI updates',
      (tester) async {
        final repository = _FakeInboxRepository()
          ..firstPageItems = [_item(id: 'unread-1'), _item(id: 'unread-2')];
        await tester.pumpWidget(
          _wrap(const NotificationsPage(), repository: repository),
        );
        await tester.pumpAndSettle();
        expect(find.byIcon(Icons.circle), findsNWidgets(2));
        await tester.tap(find.byKey(const Key('markAllReadButton')));
        await tester.pumpAndSettle();
        expect(repository.markAllReadCalls, 1);
        expect(find.byIcon(Icons.circle), findsNothing);
      },
    );
  });

  group('NotificationsPage — tap-to-navigate', () {
    testWidgets('a communication notification navigates to /messages/:id', (
      tester,
    ) async {
      final repository = _FakeInboxRepository()
        ..firstPageItems = [
          _item(
            id: 'n-1',
            notificationType: 'communication.message.created',
            titleKey: 'push.communication.newMessageTitle',
            bodyParams: const {},
            targetType: 'conversation',
            targetId: 'conversation-5',
          ),
        ];
      final router = GoRouter(
        initialLocation: '/notifications',
        routes: [
          GoRoute(
            path: '/notifications',
            builder: (_, _) => const NotificationsPage(),
          ),
          GoRoute(
            path: '/messages/:id',
            builder: (_, state) =>
                Scaffold(body: Text('message:${state.pathParameters['id']}')),
          ),
        ],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            notificationInboxRepositoryProvider.overrideWithValue(repository),
            pushMessagingCoordinatorProvider.overrideWithValue(
              _FakeCoordinator(),
            ),
            storageProvider.overrideWithValue(MemorySensitiveStorage()),
          ],
          child: MaterialApp.router(
            routerConfig: router,
            supportedLocales: AppLocalizations.supportedLocales,
            localizationsDelegates: const [
              AppLocalizations.delegate,
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byType(ListTile));
      await tester.pumpAndSettle();
      expect(find.text('message:conversation-5'), findsOneWidget);
    });

    testWidgets('an Order notification navigates to /orders/:id', (
      tester,
    ) async {
      final repository = _FakeInboxRepository()
        ..firstPageItems = [
          _item(id: 'n-1', targetType: 'order', targetId: 'order-9'),
        ];
      final router = GoRouter(
        initialLocation: '/notifications',
        routes: [
          GoRoute(
            path: '/notifications',
            builder: (_, _) => const NotificationsPage(),
          ),
          GoRoute(
            path: '/orders/:id',
            builder: (_, state) =>
                Scaffold(body: Text('order:${state.pathParameters['id']}')),
          ),
        ],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            notificationInboxRepositoryProvider.overrideWithValue(repository),
            pushMessagingCoordinatorProvider.overrideWithValue(
              _FakeCoordinator(),
            ),
            storageProvider.overrideWithValue(MemorySensitiveStorage()),
          ],
          child: MaterialApp.router(
            routerConfig: router,
            supportedLocales: AppLocalizations.supportedLocales,
            localizationsDelegates: const [
              AppLocalizations.delegate,
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byType(ListTile));
      await tester.pumpAndSettle();
      expect(find.text('order:order-9'), findsOneWidget);
    });
  });

  group('NotificationPermissionBanner', () {
    testWidgets('a not-yet-asked, undetermined status shows Enable button', (
      tester,
    ) async {
      final coordinator = _FakeCoordinator()
        ..statusResult = NotificationPermissionState.notDetermined;
      final repository = _FakeInboxRepository();
      await tester.pumpWidget(
        _wrap(
          const NotificationsPage(),
          repository: repository,
          coordinator: coordinator,
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('enableNotificationsButton')),
        findsOneWidget,
      );
    });

    testWidgets(
      'a denied status (already asked) shows a quiet "notifications off" '
      'row, not the Enable button',
      (tester) async {
        final coordinator = _FakeCoordinator()
          ..statusResult = NotificationPermissionState.denied;
        final storage = MemorySensitiveStorage();
        await storage.write(SensitiveKey.notificationPermissionAsked, 'true');
        final repository = _FakeInboxRepository();
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              notificationInboxRepositoryProvider.overrideWithValue(repository),
              pushMessagingCoordinatorProvider.overrideWithValue(coordinator),
              storageProvider.overrideWithValue(storage),
            ],
            child: MaterialApp(
              supportedLocales: AppLocalizations.supportedLocales,
              localizationsDelegates: const [
                AppLocalizations.delegate,
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              home: const Scaffold(body: NotificationsPage()),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('enableNotificationsButton')),
          findsNothing,
        );
        expect(find.byIcon(Icons.notifications_off_outlined), findsOneWidget);
        expect(
          find.byKey(const Key('openNotificationSettingsButton')),
          findsNothing,
        );
      },
    );

    testWidgets(
      'a permanently-denied status (already asked) shows the Open Settings '
      'action',
      (tester) async {
        final coordinator = _FakeCoordinator()
          ..statusResult = NotificationPermissionState.denied
          ..permanentlyDeniedResult = true;
        final storage = MemorySensitiveStorage();
        await storage.write(SensitiveKey.notificationPermissionAsked, 'true');
        final repository = _FakeInboxRepository();
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              notificationInboxRepositoryProvider.overrideWithValue(repository),
              pushMessagingCoordinatorProvider.overrideWithValue(coordinator),
              storageProvider.overrideWithValue(storage),
            ],
            child: MaterialApp(
              supportedLocales: AppLocalizations.supportedLocales,
              localizationsDelegates: const [
                AppLocalizations.delegate,
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              home: const Scaffold(body: NotificationsPage()),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final settingsButton = find.byKey(
          const Key('openNotificationSettingsButton'),
        );
        expect(settingsButton, findsOneWidget);
        await tester.tap(settingsButton);
        await tester.pumpAndSettle();
      },
    );

    testWidgets(
      'tapping Enable requests permission and persists the asked flag',
      (tester) async {
        final coordinator = _FakeCoordinator()
          ..statusResult = NotificationPermissionState.notDetermined
          ..requestResult = NotificationPermissionState.authorized;
        final storage = MemorySensitiveStorage();
        final repository = _FakeInboxRepository();
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              notificationInboxRepositoryProvider.overrideWithValue(repository),
              pushMessagingCoordinatorProvider.overrideWithValue(coordinator),
              storageProvider.overrideWithValue(storage),
            ],
            child: MaterialApp(
              supportedLocales: AppLocalizations.supportedLocales,
              localizationsDelegates: const [
                AppLocalizations.delegate,
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              home: const Scaffold(body: NotificationsPage()),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('enableNotificationsButton')));
        await tester.pumpAndSettle();
        expect(
          await storage.read(SensitiveKey.notificationPermissionAsked),
          'true',
        );
        expect(
          find.byKey(const Key('enableNotificationsButton')),
          findsNothing,
        );
      },
    );
  });

  group('NotificationsPage — Arabic/RTL smoke test', () {
    testWidgets('renders Arabic text under RTL direction without crashing', (
      tester,
    ) async {
      final repository = _FakeInboxRepository()
        ..firstPageItems = [_item(id: '1')];
      await tester.pumpWidget(
        _wrap(
          const NotificationsPage(),
          repository: repository,
          locale: const Locale('ar'),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('تحديد الكل كمقروء'), findsOneWidget);
      expect(
        Directionality.of(tester.element(find.byType(NotificationsPage))),
        TextDirection.rtl,
      );
    });
  });
}
