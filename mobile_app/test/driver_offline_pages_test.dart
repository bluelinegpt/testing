import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_pages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/driver_offline_fakes.dart';

/// `AuthenticationController` is `final` and cannot be subclassed from a
/// test file, so the fake sits one layer down at the service it reads from
/// — mirrors `driver_dashboard_and_detail_test.dart`.
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

AuthenticatedUser _driverUser() => AuthenticatedUser(
  id: 'driver-1',
  companyId: 'company-1',
  displayName: 'Test Driver',
  roles: {UserRole.driver},
  permissions: const {'mobile.driver.access'},
  accessState: AccountAccessState.active,
);

DriverOrder _driverOrder({String id = 'order-1', required String status}) =>
    DriverOrder(
      id: id,
      orderNumber: 'ORD-1',
      serialNumber: 'SN-1001',
      orderDate: '2026-08-09',
      areaId: 'area-1',
      areaName: 'Deira',
      customerName: 'Customer A',
      customerMobile: '971500000000',
      address: '123 Main Street',
      expectedCod: '100.00',
      amountCollected: '0.00',
      status: status,
      traderName: 'Plaza Store',
      emirateNameEn: 'Dubai',
      emirateNameAr: 'دبي',
    );

void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _wrap(
  Widget child, {
  required OfflineAwareDriverRepository repository,
  Locale locale = const Locale('en'),
}) => ProviderScope(
  overrides: [
    driverRepositoryProvider.overrideWithValue(repository),
    authenticationServiceProvider.overrideWithValue(
      _FakeAuthenticationService(
        AuthenticationState(
          AuthenticationStatus.authenticated,
          session: AuthenticatedSession(
            user: _driverUser(),
            expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
          ),
        ),
      ),
    ),
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
  group('Offline banner', () {
    testWidgets(
      'DriverOrdersPage shows "Offline — Last synced: …" when the list came '
      'from the cache',
      (tester) async {
        final api = ScriptedApiDriverRepository()
          ..ordersError = const ApiFailure(ApiFailureKind.network);
        final cache = FakeDriverOfflineCacheRepository();
        await cache.cacheOrders(
          companyId: 'company-1',
          driverAccountId: 'driver-1',
          orders: [_driverOrder(status: 'assigned_to_driver')],
          syncedAt: DateTime.utc(2026, 8, 9, 10, 30),
          preserveOrderIds: const {},
        );
        final repository = OfflineAwareDriverRepository(
          api: api,
          cache: cache,
          queue: FakeDriverSyncQueueRepository(),
          currentUser: () => _driverUser(),
          errorMapper: const ApiErrorMapper(),
        );
        await tester.pumpWidget(
          _wrap(const DriverOrdersPage(), repository: repository),
        );
        await tester.pumpAndSettle();
        expect(find.textContaining('Offline'), findsOneWidget);
        expect(find.textContaining('2026'), findsWidgets);
      },
    );

    testWidgets('an online load never shows the offline banner', (
      tester,
    ) async {
      final api = ScriptedApiDriverRepository()
        ..ordersResult = [_driverOrder(status: 'assigned_to_driver')];
      final repository = OfflineAwareDriverRepository(
        api: api,
        cache: FakeDriverOfflineCacheRepository(),
        queue: FakeDriverSyncQueueRepository(),
        currentUser: () => _driverUser(),
        errorMapper: const ApiErrorMapper(),
      );
      await tester.pumpWidget(
        _wrap(const DriverOrdersPage(), repository: repository),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('Offline'), findsNothing);
    });
  });

  group('Sync-state badges', () {
    testWidgets('a queued action shows "Pending Sync" on the Orders list', (
      tester,
    ) async {
      final api = ScriptedApiDriverRepository()
        ..ordersResult = [_driverOrder(status: 'assigned_to_driver')];
      final cache = FakeDriverOfflineCacheRepository();
      final queue = FakeDriverSyncQueueRepository();
      final repository = OfflineAwareDriverRepository(
        api: api,
        cache: cache,
        queue: queue,
        currentUser: () => _driverUser(),
        errorMapper: const ApiErrorMapper(),
      );
      // Prime the cache the same way orders() would, then queue an offline
      // action against it directly.
      await repository.orders();
      api.changeStatusScript.add(const ApiFailure(ApiFailureKind.network));
      await repository.changeStatus(
        'order-1',
        'out_for_delivery',
        'action-1',
        expectedStatus: 'assigned_to_driver',
      );
      await tester.pumpWidget(
        _wrap(const DriverOrdersPage(), repository: repository),
      );
      await tester.pumpAndSettle();
      expect(find.text('Pending Sync'), findsOneWidget);
    });

    testWidgets(
      'Order Detail shows "Sync Failed" with a Retry button that re-enqueues',
      (tester) async {
        _useTallViewport(tester);
        final api = ScriptedApiDriverRepository()
          ..ordersResult = [_driverOrder(status: 'assigned_to_driver')];
        final cache = FakeDriverOfflineCacheRepository();
        final queue = FakeDriverSyncQueueRepository();
        await queue.enqueue(
          DriverQueueEntry(
            localActionId: 'burned',
            companyId: 'company-1',
            driverAccountId: 'driver-1',
            orderId: 'order-1',
            targetStatus: 'out_for_delivery',
            expectedStatus: 'assigned_to_driver',
            sequence: 1,
            createdAt: DateTime.utc(2026, 8, 9),
            state: DriverSyncRowState.failed,
          ),
        );
        final repository = OfflineAwareDriverRepository(
          api: api,
          cache: cache,
          queue: queue,
          currentUser: () => _driverUser(),
          errorMapper: const ApiErrorMapper(),
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Sync Failed'), findsOneWidget);
        await tester.tap(find.widgetWithText(TextButton, 'Retry'));
        await tester.pumpAndSettle();
        final rows = await queue.forOrder(
          companyId: 'company-1',
          driverAccountId: 'driver-1',
          orderId: 'order-1',
        );
        expect(
          rows.where((r) => r.state == DriverSyncRowState.pending),
          hasLength(1),
        );
        expect(rows.any((r) => r.localActionId == 'burned'), isFalse);
      },
    );

    testWidgets(
      'Order Detail shows "Needs Review" for a conflict, and tapping it '
      'offers the localized message plus a Refresh action',
      (tester) async {
        _useTallViewport(tester);
        final api = ScriptedApiDriverRepository()
          ..ordersResult = [_driverOrder(status: 'cancelled')];
        final cache = FakeDriverOfflineCacheRepository();
        final queue = FakeDriverSyncQueueRepository();
        await queue.enqueue(
          DriverQueueEntry(
            localActionId: 'conflicted',
            companyId: 'company-1',
            driverAccountId: 'driver-1',
            orderId: 'order-1',
            targetStatus: 'delivered',
            expectedStatus: 'out_for_delivery',
            sequence: 1,
            createdAt: DateTime.utc(2026, 8, 9),
            state: DriverSyncRowState.conflict,
          ),
        );
        final repository = OfflineAwareDriverRepository(
          api: api,
          cache: cache,
          queue: queue,
          currentUser: () => _driverUser(),
          errorMapper: const ApiErrorMapper(),
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Needs Review'), findsOneWidget);
        await tester.tap(find.text('Needs Review'));
        await tester.pumpAndSettle();
        expect(
          find.text(
            'This Order changed while you were offline. Refresh the Order '
            'before continuing.',
          ),
          findsOneWidget,
        );
        await tester.tap(find.widgetWithText(FilledButton, 'Refresh'));
        await tester.pumpAndSettle();
        final rows = await queue.forOrder(
          companyId: 'company-1',
          driverAccountId: 'driver-1',
          orderId: 'order-1',
        );
        expect(rows, isEmpty);
      },
    );
  });

  group('Arabic / RTL', () {
    testWidgets('the offline banner and a sync badge render in Arabic', (
      tester,
    ) async {
      final api = ScriptedApiDriverRepository()
        ..ordersError = const ApiFailure(ApiFailureKind.network);
      final cache = FakeDriverOfflineCacheRepository();
      await cache.cacheOrders(
        companyId: 'company-1',
        driverAccountId: 'driver-1',
        orders: [_driverOrder(status: 'assigned_to_driver')],
        syncedAt: DateTime.utc(2026, 8, 9, 10, 30),
        preserveOrderIds: const {},
      );
      final queue = FakeDriverSyncQueueRepository();
      await queue.enqueue(
        DriverQueueEntry(
          localActionId: 'action-1',
          companyId: 'company-1',
          driverAccountId: 'driver-1',
          orderId: 'order-1',
          targetStatus: 'out_for_delivery',
          sequence: 1,
          createdAt: DateTime.utc(2026, 8, 9),
          state: DriverSyncRowState.pending,
        ),
      );
      final repository = OfflineAwareDriverRepository(
        api: api,
        cache: cache,
        queue: queue,
        currentUser: () => _driverUser(),
        errorMapper: const ApiErrorMapper(),
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrdersPage(),
          repository: repository,
          locale: const Locale('ar'),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        Directionality.of(tester.element(find.byType(DriverOrdersPage))),
        TextDirection.rtl,
      );
      expect(find.textContaining('غير متصل'), findsOneWidget);
      expect(find.text('بانتظار المزامنة'), findsOneWidget);
    });
  });
}
