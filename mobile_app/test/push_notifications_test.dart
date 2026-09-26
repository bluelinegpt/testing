import 'dart:async';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/push_notification_controller.dart';
import 'package:bluelinegpt_mobile/app/routing/app_router.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

/// In-memory double for `PushMessagingCoordinator` — mirrors the
/// `FakeDriverRepository` style (`test/driver_dashboard_and_detail_test.dart`):
/// a plain class implementing the interface with controllable streams and
/// call counters, never a real Firebase call.
final class _FakeCoordinator implements PushMessagingCoordinator {
  final _tokenController = StreamController<String>.broadcast();
  final _foregroundController =
      StreamController<Map<String, Object?>>.broadcast();
  final _tapController = StreamController<Map<String, Object?>>.broadcast();
  Map<String, Object?>? initialTap;
  NotificationPermissionState statusResult =
      NotificationPermissionState.notDetermined;
  NotificationPermissionState requestResult =
      NotificationPermissionState.denied;
  bool permanentlyDeniedResult = false;
  int openSettingsCalls = 0;
  int requestPermissionCalls = 0;

  @override
  Future<NotificationPermissionState> permissionStatus() async => statusResult;
  @override
  Future<NotificationPermissionState> requestPermission() async {
    requestPermissionCalls += 1;
    return requestResult;
  }

  @override
  Future<bool> isPermanentlyDenied() async => permanentlyDeniedResult;
  @override
  Future<bool> openSettings() async {
    openSettingsCalls += 1;
    return true;
  }

  @override
  Stream<String> get onTokenRefresh => _tokenController.stream;
  @override
  Stream<Map<String, Object?>> get onForegroundMessage =>
      _foregroundController.stream;
  @override
  Stream<Map<String, Object?>> get onNotificationTap => _tapController.stream;
  @override
  Future<Map<String, Object?>?> initialNotificationTap() async => initialTap;

  void emitToken(String token) => _tokenController.add(token);
  void emitForeground(Map<String, Object?> data) =>
      _foregroundController.add(data);
  void emitTap(Map<String, Object?> data) => _tapController.add(data);

  Future<void> dispose() async {
    await _tokenController.close();
    await _foregroundController.close();
    await _tapController.close();
  }
}

final class _FakeDevice implements DeviceRegistrationService {
  int registered = 0;
  String? lastToken;
  @override
  Future<void> register(String token, AuthenticatedUser user) async {
    registered += 1;
    lastToken = token;
  }

  @override
  Future<void> deregister() async {}
}

final class _FakeAuthenticationService implements AuthenticationService {
  _FakeAuthenticationService(this.state);
  final AuthenticationState state;
  @override
  Future<AuthenticationState> restore() async => state;
  @override
  Future<AuthenticationState> login(LoginInput input) async => state;
  @override
  Future<void> logout() async {}
  @override
  Future<String?> changePassword(
    String currentPassword,
    String newPassword,
  ) async => null;
}

AuthenticatedUser _user() => AuthenticatedUser(
  id: 'user-1',
  companyId: 'company-1',
  displayName: 'Test User',
  roles: {UserRole.driver},
  permissions: const {},
  accessState: AccountAccessState.active,
);

AuthenticatedSession _session() => AuthenticatedSession(
  user: _user(),
  expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
);

void main() {
  group('refreshScopeFor', () {
    test('classifies communication vs order vs unrelated types', () {
      expect(
        refreshScopeFor('communication.message.created'),
        PushRefreshScope.communication,
      );
      expect(refreshScopeFor('order.assigned'), PushRefreshScope.orders);
      expect(refreshScopeFor('order.reassigned'), PushRefreshScope.orders);
      expect(refreshScopeFor('order.status_changed'), PushRefreshScope.orders);
      expect(refreshScopeFor('unknown.future_type'), PushRefreshScope.none);
      expect(refreshScopeFor(''), PushRefreshScope.none);
    });
  });

  group('titleForNotification / bodyForNotification', () {
    test(
      'maps every known titleKey, and falls back safely for unknown keys',
      () async {
        final l10n = await AppLocalizations.delegate.load(const Locale('en'));
        expect(
          titleForNotification('push.communication.newMessageTitle', l10n),
          l10n.newMessageNotification,
        );
        expect(
          titleForNotification('push.order.assignedTitle', l10n),
          l10n.orderAssignedNotification,
        );
        expect(
          titleForNotification('push.order.reassignedTitle', l10n),
          l10n.orderReassignedNotification,
        );
        expect(
          titleForNotification('push.order.statusChangedTitle', l10n),
          l10n.orderUpdatedNotification,
        );
        expect(titleForNotification(null, l10n), l10n.notifications);
        expect(
          titleForNotification('push.unknown.key', l10n),
          l10n.notifications,
        );
      },
    );

    test(
      'resolves communication bodyKeys directly and formats an Order '
      'status_changed body from bodyParams using the shared status labels',
      () async {
        final l10n = await AppLocalizations.delegate.load(const Locale('en'));
        expect(
          bodyForNotification(
            notificationType: 'communication.message.created',
            bodyKey: 'push.communication.newTextMessageBody',
            bodyParams: const {},
            l10n: l10n,
          ),
          l10n.newMessageNotification,
        );
        expect(
          bodyForNotification(
            notificationType: 'communication.message.created',
            bodyKey: 'push.communication.newVoiceMessageBody',
            bodyParams: const {},
            l10n: l10n,
          ),
          l10n.voiceMessageNotification,
        );
        expect(
          bodyForNotification(
            notificationType: 'order.status_changed',
            bodyKey: null,
            bodyParams: const {'status': 'delivered'},
            l10n: l10n,
          ),
          l10n.delivered,
        );
        expect(
          bodyForNotification(
            notificationType: 'order.assigned',
            bodyKey: null,
            bodyParams: const {},
            l10n: l10n,
          ),
          isNull,
        );
      },
    );
  });

  group('PushNotificationController', () {
    late _FakeCoordinator coordinator;
    late _FakeDevice device;
    late ProviderContainer container;
    late GoRouter router;
    final visited = <String>[];

    List<RouteBase> testRoutes() => [
      GoRoute(path: '/login', builder: (_, _) => const Text('login')),
      GoRoute(path: '/dashboard', builder: (_, _) => const Text('dashboard')),
      GoRoute(
        path: '/messages/:id',
        builder: (_, state) {
          visited.add('/messages/${state.pathParameters['id']}');
          return const Text('message');
        },
      ),
      GoRoute(
        path: '/orders/:id',
        builder: (_, state) {
          visited.add('/orders/${state.pathParameters['id']}');
          return const Text('order');
        },
      ),
      GoRoute(
        path: '/notifications',
        builder: (_, _) {
          visited.add('/notifications');
          return const Text('notifications');
        },
      ),
    ];

    setUp(() async {
      coordinator = _FakeCoordinator();
      device = _FakeDevice();
      visited.clear();
      router = GoRouter(
        initialLocation: '/dashboard',
        redirect: (context, state) => redirectFor(
          container.read(authenticationProvider).value,
          state.matchedLocation,
          intended: state.uri.queryParameters['from'],
        ),
        routes: testRoutes(),
      );
      container = ProviderContainer(
        overrides: [
          pushMessagingCoordinatorProvider.overrideWithValue(coordinator),
          deviceRegistrationProvider.overrideWithValue(device),
          authenticationServiceProvider.overrideWithValue(
            _FakeAuthenticationService(
              AuthenticationState(
                AuthenticationStatus.authenticated,
                session: _session(),
              ),
            ),
          ),
          routerProvider.overrideWithValue(router),
        ],
      );
      addTearDown(container.dispose);
      addTearDown(coordinator.dispose);
      // The controller reads the current session on a token refresh — make
      // sure `authenticationProvider` has actually resolved first.
      await container.read(authenticationProvider.future);
    });

    /// `router.go()` only actually builds a route (and so only actually
    /// populates `visited`) once it is driving a real, pumped widget tree —
    /// `UncontrolledProviderScope` reuses the exact same `container` (and so
    /// the exact same `router` instance) the controller under test reads
    /// from, instead of starting a second, disconnected one.
    Future<void> pumpApp(WidgetTester tester) async {
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(
            routerConfig: router,
            supportedLocales: const [Locale('en')],
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets(
      'a token refresh re-registers the device with the new token for the '
      'current session',
      (tester) async {
        container.read(pushNotificationControllerProvider);
        coordinator.emitToken('new-token');
        await tester.pump();
        expect(device.registered, 1);
        expect(device.lastToken, 'new-token');
      },
    );

    testWidgets(
      'a foreground communication push bumps only the communication refresh '
      'signal, never the orders signal',
      (tester) async {
        container.read(pushNotificationControllerProvider);
        coordinator.emitForeground({
          'notificationType': 'communication.message.created',
        });
        await tester.pump();
        expect(container.read(communicationRefreshSignalProvider), 1);
        expect(container.read(ordersRefreshSignalProvider), 0);
      },
    );

    testWidgets(
      'a foreground Order push bumps only the orders refresh signal, never '
      'the communication signal',
      (tester) async {
        container.read(pushNotificationControllerProvider);
        coordinator.emitForeground({'notificationType': 'order.assigned'});
        await tester.pump();
        expect(container.read(ordersRefreshSignalProvider), 1);
        expect(container.read(communicationRefreshSignalProvider), 0);
      },
    );

    testWidgets(
      'a duplicate foreground event only ever increments its own signal '
      'once per event — never a combined/double count across scopes',
      (tester) async {
        container.read(pushNotificationControllerProvider);
        coordinator.emitForeground({
          'notificationType': 'communication.message.created',
        });
        coordinator.emitForeground({
          'notificationType': 'communication.message.created',
        });
        await tester.pump();
        // Two pushes legitimately bump the signal twice — the "no double
        // count" guarantee is structural (each consumer treats this as a
        // stateless refresh hint, never a literal counter shown to the
        // user); see the widget-level dedup test in
        // `communication_pages_test.dart`.
        expect(container.read(communicationRefreshSignalProvider), 2);
        expect(container.read(ordersRefreshSignalProvider), 0);
      },
    );

    testWidgets(
      'tapping a communication notification navigates to /messages/:id',
      (tester) async {
        await pumpApp(tester);
        container.read(pushNotificationControllerProvider);
        coordinator.emitTap({
          'targetType': 'conversation',
          'targetId': 'conversation-9',
        });
        await tester.pumpAndSettle();
        expect(visited, contains('/messages/conversation-9'));
      },
    );

    testWidgets('tapping an Order notification navigates to /orders/:id', (
      tester,
    ) async {
      await pumpApp(tester);
      container.read(pushNotificationControllerProvider);
      coordinator.emitTap({'targetType': 'order', 'targetId': 'order-7'});
      await tester.pumpAndSettle();
      expect(visited, contains('/orders/order-7'));
    });

    testWidgets(
      'a terminated-launch tap (getInitialMessage) is handled exactly like '
      'a live onMessageOpenedApp tap, once startup has already resolved',
      (tester) async {
        coordinator.initialTap = {
          'targetType': 'order',
          'targetId': 'order-cold-start',
        };
        await pumpApp(tester);
        container.read(pushNotificationControllerProvider);
        await tester.pumpAndSettle();
        expect(visited, contains('/orders/order-cold-start'));
      },
    );

    testWidgets(
      'a notification tap while logged out is redirected to /login, never '
      'the target page (shared redirectFor mechanism)',
      (tester) async {
        final loggedOutRouter = GoRouter(
          initialLocation: '/dashboard',
          redirect: (context, state) => redirectFor(
            null,
            state.matchedLocation,
            intended: state.uri.queryParameters['from'],
          ),
          routes: testRoutes(),
        );
        final loggedOutContainer = ProviderContainer(
          overrides: [
            pushMessagingCoordinatorProvider.overrideWithValue(coordinator),
            deviceRegistrationProvider.overrideWithValue(device),
            authenticationServiceProvider.overrideWithValue(
              _FakeAuthenticationService(
                const AuthenticationState.unauthenticated(),
              ),
            ),
            routerProvider.overrideWithValue(loggedOutRouter),
          ],
        );
        addTearDown(loggedOutContainer.dispose);
        await loggedOutContainer.read(authenticationProvider.future);
        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: loggedOutContainer,
            child: MaterialApp.router(
              routerConfig: loggedOutRouter,
              supportedLocales: const [Locale('en')],
            ),
          ),
        );
        await tester.pumpAndSettle();
        loggedOutContainer.read(pushNotificationControllerProvider);
        coordinator.emitTap({'targetType': 'order', 'targetId': 'order-1'});
        await tester.pumpAndSettle();
        expect(loggedOutRouter.state.uri.path, '/login');
      },
    );
  });
}
