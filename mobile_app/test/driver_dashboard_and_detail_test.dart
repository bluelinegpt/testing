import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/features/common/pages.dart';
import 'package:bluelinegpt_mobile/features/dashboard/dashboard_page.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_order_detail_view.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_pages.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_repository.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_models.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_repository.dart';
import 'package:bluelinegpt_mobile/features/trader/trader_pages.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

/// An in-memory double for `DriverRepository` — no network, no dio mocking
/// needed, since the interface itself is the seam. Mirrors
/// `FakeOperatorRepository`'s shape in `operator_dashboard_and_detail_test.dart`.
final class FakeDriverRepository implements DriverRepository {
  FakeDriverRepository({
    this.ordersResult = const [],
    this.ordersError,
    this.summaryResult,
    this.summaryError,
    this.historyResult = const [],
    this.historyError,
  });
  List<DriverOrder> ordersResult;
  Object? ordersError;
  DriverDashboardSummary? summaryResult;
  Object? summaryError;
  List<DriverOrderHistoryEvent> historyResult;
  Object? historyError;
  int ordersCalls = 0;
  int historyCalls = 0;
  int changeStatusCalls = 0;
  String? lastStatusTarget;
  String? lastStatusReason;
  String? lastExpectedStatus;
  final List<String> idempotencyKeysUsed = [];
  bool failNextAction = false;

  @override
  Future<List<DriverOrder>> orders() async {
    ordersCalls += 1;
    if (ordersError != null) throw ordersError!;
    return ordersResult;
  }

  @override
  Future<DriverDashboardSummary> dashboardSummary() async {
    if (summaryError != null) throw summaryError!;
    return summaryResult!;
  }

  @override
  Future<List<DriverOrderHistoryEvent>> history(String orderId) async {
    historyCalls += 1;
    if (historyError != null) throw historyError!;
    return historyResult;
  }

  @override
  Future<DriverOrder> changeStatus(
    String orderId,
    String status,
    String idempotencyKey, {
    String? reason,
    String? expectedStatus,
  }) async {
    changeStatusCalls += 1;
    lastStatusTarget = status;
    lastStatusReason = reason;
    lastExpectedStatus = expectedStatus;
    idempotencyKeysUsed.add(idempotencyKey);
    if (failNextAction) throw Exception('status change failed');
    final current = ordersResult.firstWhere((o) => o.id == orderId);
    final updated = DriverOrder(
      id: current.id,
      orderNumber: current.orderNumber,
      serialNumber: current.serialNumber,
      orderDate: current.orderDate,
      areaId: current.areaId,
      areaName: current.areaName,
      customerName: current.customerName,
      customerMobile: current.customerMobile,
      address: current.address,
      expectedCod: current.expectedCod,
      amountCollected: current.amountCollected,
      status: status,
      traderName: current.traderName,
      reference: current.reference,
      notes: current.notes,
      emirateNameEn: current.emirateNameEn,
      emirateNameAr: current.emirateNameAr,
    );
    if (status == 'hold') {
      // Mirrors the real backend: `GET portal/driver/orders`
      // (`driverPortalOrders()`) deliberately excludes `hold` from its
      // status filter, so a just-Held Order drops off the list this fake's
      // `orders()` returns — exactly like production.
      ordersResult = [
        for (final o in ordersResult)
          if (o.id != orderId) o,
      ];
    } else {
      ordersResult = [
        for (final o in ordersResult)
          if (o.id == orderId) updated else o,
      ];
    }
    return updated;
  }
}

/// Proves a Driver dashboard never reaches the Operator's dashboard-summary
/// endpoint — every method beyond `dashboardSummary()` is deliberately
/// unimplemented, since a correct Driver session must never call any of
/// them either.
final class _CountingOperatorRepository implements OperatorRepository {
  int dashboardSummaryCalls = 0;
  @override
  Future<OperatorDashboardSummary> dashboardSummary() async {
    dashboardSummaryCalls += 1;
    throw UnimplementedError('Driver session must never call this');
  }

  @override
  Future<void> assign(String orderId, String driverId) =>
      throw UnimplementedError();
  @override
  Future<void> changeStatus(String orderId, String status, {String? reason}) =>
      throw UnimplementedError();
  @override
  Future<OperatorOrder> detail(String id) => throw UnimplementedError();
  @override
  Future<List<OperatorDriver>> drivers() => throw UnimplementedError();
  @override
  Future<OperatorOrderPage> orders({
    int page = 1,
    String? search,
    String? status,
  }) => throw UnimplementedError();
}

/// `AuthenticationController` is `final` and cannot be subclassed from a
/// test file, so the fake sits one layer down at the service it reads from
/// — `restore()` is exactly what `AuthenticationController.build()` calls.
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
  permissions: {'mobile.driver.access'},
  accessState: AccountAccessState.active,
);

AuthenticatedSession _sessionFor(AuthenticatedUser user) =>
    AuthenticatedSession(
      user: user,
      expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
    );

DriverOrder _driverOrder({
  String id = 'order-1',
  required String status,
  String? reference,
}) => DriverOrder(
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
  reference: reference,
  emirateNameEn: 'Dubai',
  emirateNameAr: 'دبي',
);

Widget _wrap(
  Widget child, {
  required FakeDriverRepository repository,
  required AuthenticatedUser user,
}) => ProviderScope(
  overrides: [
    driverRepositoryProvider.overrideWithValue(repository),
    authenticationServiceProvider.overrideWithValue(
      _FakeAuthenticationService(
        AuthenticationState(
          AuthenticationStatus.authenticated,
          session: _sessionFor(user),
        ),
      ),
    ),
  ],
  child: MaterialApp(
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

/// `DriverOrderDetailsPage` renders more field rows than fit the default
/// 800×600 test surface — a tall viewport keeps every row (and the action
/// buttons below them) actually laid out and painted, matching how
/// `mobile_ui_components_test.dart` handles the same situation.
void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  group('DriverDashboardSummary.fromJson', () {
    test('parses a well-formed response', () {
      final summary = DriverDashboardSummary.fromJson({
        'activeTotal': 5,
        'assignedToMe': 2,
        'deliveredToday': 1,
        'outForDelivery': 3,
        'returnPending': 0,
      });
      expect(summary.activeTotal, 5);
      expect(summary.assignedToMe, 2);
      expect(summary.outForDelivery, 3);
      expect(summary.deliveredToday, 1);
      expect(summary.returnPending, 0);
    });
    test('fails loud on a missing required field instead of defaulting', () {
      expect(
        () => DriverDashboardSummary.fromJson({
          'activeTotal': 1,
          'deliveredToday': 0,
          'outForDelivery': 0,
          'returnPending': 0,
        }),
        throwsA(isA<DriverDashboardParseError>()),
      );
    });
    test('fails loud on a non-integer field', () {
      expect(
        () => DriverDashboardSummary.fromJson({
          'activeTotal': '5',
          'assignedToMe': 0,
          'deliveredToday': 0,
          'outForDelivery': 0,
          'returnPending': 0,
        }),
        throwsA(isA<DriverDashboardParseError>()),
      );
    });
  });

  group('driverDashboardCards', () {
    test(
      'maps the summary to exactly 5 cards with the correct values and deep links',
      () async {
        final l10n = await AppLocalizations.delegate.load(const Locale('en'));
        const summary = DriverDashboardSummary(
          activeTotal: 9,
          assignedToMe: 4,
          deliveredToday: 2,
          outForDelivery: 5,
          returnPending: 1,
        );
        final cards = driverDashboardCards(summary, l10n);
        expect(cards, hasLength(5));
        expect(cards[0].title, l10n.myActiveOrders);
        expect(cards[0].value, 9);
        expect(cards[0].route, '/orders');
        expect(cards[1].title, l10n.assignedToMe);
        expect(cards[1].value, 4);
        expect(cards[1].route, '/orders?deliveryStatus=assigned_to_driver');
        expect(cards[2].title, l10n.outForDelivery);
        expect(cards[2].value, 5);
        expect(cards[2].route, '/orders?deliveryStatus=out_for_delivery');
        expect(cards[3].title, l10n.deliveredToday);
        expect(cards[3].value, 2);
        expect(cards[3].route, '/orders?deliveryStatus=delivered');
        expect(cards[4].title, l10n.returnPending);
        expect(cards[4].value, 1);
        expect(cards[4].route, '/orders?deliveryStatus=returned_to_branch');
      },
    );
  });

  group('DriverOrdersPage — status filter', () {
    testWidgets('with no filter, shows every assigned Order', (tester) async {
      final repository = FakeDriverRepository(
        ordersResult: [
          _driverOrder(id: 'order-1', status: 'assigned_to_driver'),
          _driverOrder(id: 'order-2', status: 'out_for_delivery'),
        ],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrdersPage(),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(OrderCard), findsNWidgets(2));
    });

    testWidgets('with initialDeliveryStatus set, shows only matching Orders', (
      tester,
    ) async {
      final repository = FakeDriverRepository(
        ordersResult: [
          _driverOrder(id: 'order-1', status: 'assigned_to_driver'),
          _driverOrder(id: 'order-2', status: 'out_for_delivery'),
          _driverOrder(id: 'order-3', status: 'out_for_delivery'),
        ],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrdersPage(initialDeliveryStatus: 'out_for_delivery'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(OrderCard), findsNWidgets(2));
    });

    testWidgets(
      'a filter matching no Order shows the empty state, not an error',
      (tester) async {
        final repository = FakeDriverRepository(
          ordersResult: [_driverOrder(id: 'order-1', status: 'delivered')],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrdersPage(initialDeliveryStatus: 'returned_to_branch'),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byType(OrderCard), findsNothing);
      },
    );

    testWidgets(
      'a foreground Order push refresh signal re-fetches the list as a hint '
      '(Prompt 15 §U), not a manual patch of any single Order',
      (tester) async {
        final repository = FakeDriverRepository(
          ordersResult: [
            _driverOrder(id: 'order-1', status: 'assigned_to_driver'),
          ],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrdersPage(),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        final callsAfterInitialLoad = repository.ordersCalls;
        expect(callsAfterInitialLoad, greaterThan(0));

        final container = ProviderScope.containerOf(
          tester.element(find.byType(DriverOrdersPage)),
        );
        container.read(ordersRefreshSignalProvider.notifier).state++;
        await tester.pumpAndSettle();

        expect(repository.ordersCalls, greaterThan(callsAfterInitialLoad));
        expect(find.byType(OrderCard), findsOneWidget);
      },
    );
  });

  group(
    'RoleOrdersPage — Driver dashboard card navigation actually filters',
    () {
      testWidgets('tapping "Assigned to Me" opens the real Driver Orders list '
          'filtered to assigned_to_driver only', (tester) async {
        final repository = FakeDriverRepository(
          ordersResult: [
            _driverOrder(id: 'order-1', status: 'assigned_to_driver'),
            _driverOrder(id: 'order-2', status: 'out_for_delivery'),
          ],
          summaryResult: const DriverDashboardSummary(
            activeTotal: 2,
            assignedToMe: 1,
            deliveredToday: 0,
            outForDelivery: 1,
            returnPending: 0,
          ),
        );
        final router = GoRouter(
          initialLocation: '/dashboard',
          routes: [
            GoRoute(
              path: '/dashboard',
              builder: (_, _) => const RoleDashboardPage(),
            ),
            GoRoute(
              path: '/orders',
              builder: (_, state) => RoleOrdersPage(
                initialDeliveryStatus:
                    state.uri.queryParameters['deliveryStatus'],
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              driverRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUser()),
                  ),
                ),
              ),
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
        await tester.tap(find.text('Assigned to Me'));
        await tester.pumpAndSettle();
        expect(find.byType(OrderCard), findsOneWidget);
      });
    },
  );

  group('RoleDashboardPage — Driver', () {
    testWidgets(
      'uses the real Driver-specific summary, not static placeholders',
      (tester) async {
        final repository = FakeDriverRepository(
          summaryResult: const DriverDashboardSummary(
            activeTotal: 7,
            assignedToMe: 3,
            deliveredToday: 1,
            outForDelivery: 4,
            returnPending: 0,
          ),
        );
        await tester.pumpWidget(
          _wrap(
            const RoleDashboardPage(),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pump();
        expect(find.byType(DashboardSkeleton), findsOneWidget);
        await tester.pumpAndSettle();
        expect(find.text('7'), findsOneWidget);
        expect(find.text('3'), findsOneWidget);
        expect(find.text('4'), findsOneWidget);
      },
    );

    testWidgets('role label reads Driver, never Operator', (tester) async {
      final repository = FakeDriverRepository(
        summaryResult: const DriverDashboardSummary(
          activeTotal: 0,
          assignedToMe: 0,
          deliveredToday: 0,
          outForDelivery: 0,
          returnPending: 0,
        ),
      );
      await tester.pumpWidget(
        _wrap(
          const RoleDashboardPage(),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Driver'), findsOneWidget);
      expect(find.text('Operator'), findsNothing);
    });

    testWidgets(
      'never calls the Operator dashboard-summary API and never renders '
      'Operator-only company-wide cards',
      (tester) async {
        final driverRepository = FakeDriverRepository(
          summaryResult: const DriverDashboardSummary(
            activeTotal: 2,
            assignedToMe: 2,
            deliveredToday: 0,
            outForDelivery: 0,
            returnPending: 0,
          ),
        );
        final operatorRepository = _CountingOperatorRepository();
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              driverRepositoryProvider.overrideWithValue(driverRepository),
              operatorRepositoryProvider.overrideWithValue(operatorRepository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUser()),
                  ),
                ),
              ),
            ],
            child: MaterialApp(
              supportedLocales: AppLocalizations.supportedLocales,
              localizationsDelegates: const [
                AppLocalizations.delegate,
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              home: const Scaffold(body: RoleDashboardPage()),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(operatorRepository.dashboardSummaryCalls, 0);
        // The Company-wide "New" card and the Operator's "Total Active
        // Orders" title never appear on a Driver's dashboard.
        expect(find.text('New'), findsNothing);
        expect(find.text('Total Active Orders'), findsNothing);
        expect(find.text('My Active Orders'), findsOneWidget);
      },
    );

    testWidgets('renders all 5 cards with correct values', (tester) async {
      final repository = FakeDriverRepository(
        summaryResult: const DriverDashboardSummary(
          activeTotal: 12,
          assignedToMe: 5,
          deliveredToday: 3,
          outForDelivery: 7,
          returnPending: 2,
        ),
      );
      await tester.pumpWidget(
        _wrap(
          const RoleDashboardPage(),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('My Active Orders'), findsOneWidget);
      expect(find.text('12'), findsOneWidget);
      expect(find.text('Assigned to Me'), findsOneWidget);
      expect(find.text('5'), findsOneWidget);
      expect(find.text('Out for Delivery'), findsOneWidget);
      expect(find.text('7'), findsOneWidget);
      expect(find.text('Delivered today'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);
      expect(find.text('Return Pending'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
    });

    testWidgets('shows a retryable error state when the summary call fails', (
      tester,
    ) async {
      final repository = FakeDriverRepository(summaryError: Exception('boom'));
      await tester.pumpWidget(
        _wrap(
          const RoleDashboardPage(),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(TextButton), findsWidgets);
      repository.summaryResult = const DriverDashboardSummary(
        activeTotal: 1,
        assignedToMe: 1,
        deliveredToday: 0,
        outForDelivery: 0,
        returnPending: 0,
      );
      repository.summaryError = null;
      await tester.tap(find.byType(TextButton).first);
      await tester.pumpAndSettle();
      expect(find.text('1'), findsWidgets);
    });

    testWidgets(
      'tapping a card navigates to the correctly-filtered Orders route',
      (tester) async {
        final repository = FakeDriverRepository(
          summaryResult: const DriverDashboardSummary(
            activeTotal: 7,
            assignedToMe: 3,
            deliveredToday: 0,
            outForDelivery: 4,
            returnPending: 0,
          ),
        );
        final router = GoRouter(
          initialLocation: '/dashboard',
          routes: [
            GoRoute(
              path: '/dashboard',
              builder: (_, _) => const RoleDashboardPage(),
            ),
            GoRoute(
              path: '/orders',
              builder: (_, state) =>
                  Scaffold(body: Text('orders:${state.uri}')),
            ),
          ],
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              driverRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUser()),
                  ),
                ),
              ),
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
        await tester.tap(find.text('Assigned to Me'));
        await tester.pumpAndSettle();
        expect(
          find.textContaining(
            'orders:/orders?deliveryStatus=assigned_to_driver',
          ),
          findsOneWidget,
        );
      },
    );
  });

  group('DriverOrderDetailsPage — fields', () {
    testWidgets('renders Serial No., Order Date, Emirate, Area, and Address', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'assigned_to_driver')],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('SN-1001'), findsOneWidget);
      expect(find.text('09 Aug 2026'), findsOneWidget);
      expect(find.textContaining('Dubai'), findsOneWidget);
      expect(find.textContaining('Deira'), findsOneWidget);
      expect(find.textContaining('123 Main Street'), findsOneWidget);
    });

    testWidgets(
      'renders Customer and Mobile as separate labeled rows, and the Trader',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeDriverRepository(
          ordersResult: [_driverOrder(status: 'assigned_to_driver')],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Customer'), findsOneWidget);
        expect(find.text('Customer A'), findsOneWidget);
        expect(find.text('Mobile'), findsOneWidget);
        expect(find.text('971500000000'), findsOneWidget);
        expect(find.text('Trader'), findsOneWidget);
        expect(find.text('Plaza Store'), findsOneWidget);
      },
    );

    testWidgets('renders the localized placeholder for an empty Address', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [
          DriverOrder(
            id: 'order-1',
            orderNumber: 'ORD-1',
            serialNumber: 'SN-1001',
            orderDate: '2026-08-09',
            areaId: 'area-1',
            areaName: 'Deira',
            customerName: 'Customer A',
            customerMobile: '971500000000',
            address: '',
            expectedCod: '100.00',
            amountCollected: '0.00',
            status: 'assigned_to_driver',
            traderName: 'Plaza Store',
            emirateNameEn: 'Dubai',
            emirateNameAr: 'دبي',
          ),
        ],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Address'), findsOneWidget);
      expect(find.text('—'), findsWidgets);
    });

    testWidgets('renders a non-empty Reference verbatim', (tester) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [
          _driverOrder(status: 'assigned_to_driver', reference: 'REF-77'),
        ],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('REF-77'), findsOneWidget);
    });

    testWidgets('renders the localized placeholder for a null Reference', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'assigned_to_driver')],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('—'), findsOneWidget);
    });

    testWidgets('never renders a Reassign/Assign Driver control', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'assigned_to_driver')],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('Assign Driver'), findsNothing);
      expect(find.textContaining('Reassign Driver'), findsNothing);
      expect(find.text('Assigned Driver'), findsNothing);
    });
  });

  group('DriverOrderDetailsPage — status actions', () {
    testWidgets('assigned_to_driver shows exactly Start Delivery', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'assigned_to_driver')],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.widgetWithText(FilledButton, 'Start Delivery'),
        findsOneWidget,
      );
      expect(find.widgetWithText(FilledButton, 'Delivered'), findsNothing);
      expect(find.widgetWithText(OutlinedButton, 'Hold'), findsNothing);
      expect(
        find.widgetWithText(OutlinedButton, 'Return to Branch'),
        findsNothing,
      );
    });

    testWidgets(
      'out_for_delivery shows exactly Delivered, Hold, and Return to Branch',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeDriverRepository(
          ordersResult: [_driverOrder(status: 'out_for_delivery')],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(FilledButton, 'Delivered'), findsOneWidget);
        expect(find.widgetWithText(OutlinedButton, 'Hold'), findsOneWidget);
        expect(
          find.widgetWithText(OutlinedButton, 'Return to Branch'),
          findsOneWidget,
        );
        expect(
          find.widgetWithText(FilledButton, 'Start Delivery'),
          findsNothing,
        );
      },
    );

    testWidgets('a terminal status shows no action buttons', (tester) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'delivered')],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(FilledButton), findsNothing);
      expect(
        find.widgetWithText(OutlinedButton, 'Return to Branch'),
        findsNothing,
      );
    });

    testWidgets(
      'confirming Start Delivery calls the repository with out_for_delivery and a fresh key, then refreshes',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeDriverRepository(
          ordersResult: [_driverOrder(status: 'assigned_to_driver')],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Start Delivery'));
        await tester.pumpAndSettle();
        await tester.tap(
          find.widgetWithText(FilledButton, 'Start Delivery').last,
        );
        await tester.pumpAndSettle();
        expect(repository.changeStatusCalls, 1);
        expect(repository.lastStatusTarget, 'out_for_delivery');
        expect(repository.idempotencyKeysUsed, hasLength(1));
        expect(repository.idempotencyKeysUsed.single, isNotEmpty);
        expect(find.text('Delivery started.'), findsOneWidget);
        // The displayed status refreshes without a manual pull-to-refresh.
        expect(find.widgetWithText(FilledButton, 'Delivered'), findsOneWidget);
        expect(
          find.widgetWithText(FilledButton, 'Start Delivery'),
          findsNothing,
        );
      },
    );

    testWidgets(
      'confirming Delivered calls the repository with delivered, then refreshes',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeDriverRepository(
          ordersResult: [_driverOrder(status: 'out_for_delivery')],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Delivered'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Delivered').last);
        await tester.pumpAndSettle();
        expect(repository.changeStatusCalls, 1);
        expect(repository.lastStatusTarget, 'delivered');
        expect(find.text('Status updated.'), findsOneWidget);
        // Terminal-for-the-Driver after Delivered — no action buttons.
        expect(find.byType(FilledButton), findsNothing);
        expect(find.widgetWithText(OutlinedButton, 'Hold'), findsNothing);
      },
    );

    testWidgets('Hold without a reason cannot be confirmed', (tester) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'out_for_delivery')],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Hold'));
      await tester.pumpAndSettle();
      final confirmButton = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Hold'),
      );
      expect(confirmButton.onPressed, isNull);
      expect(repository.changeStatusCalls, 0);
    });

    testWidgets(
      'Hold with a reason succeeds, shows the explicit Hold confirmation, '
      'and the Order remains viewable even though it drops off the Orders '
      'list filter (backend design, not an error)',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeDriverRepository(
          ordersResult: [_driverOrder(status: 'out_for_delivery')],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(OutlinedButton, 'Hold'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), 'Customer unreachable');
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Hold'));
        await tester.pumpAndSettle();
        expect(repository.changeStatusCalls, 1);
        expect(repository.lastStatusTarget, 'hold');
        expect(repository.lastStatusReason, 'Customer unreachable');
        // The explicit Hold confirmation, not the generic "Status updated."
        expect(find.text('Order placed on Hold.'), findsOneWidget);
        // No false "Data is currently unavailable" error, even though the
        // held Order is no longer present in `orders()` (the list this
        // page's own reload searches) — it must use the PATCH response's
        // authoritative Order instead of reporting it missing.
        expect(find.text('Data is currently unavailable.'), findsNothing);
        expect(find.text('SN-1001'), findsOneWidget);
        // Hold is terminal for a Driver — no `hold -> anything` transition
        // exists in `driverTransitions`; only Operations can move it again.
        expect(find.byType(FilledButton), findsNothing);
        expect(find.widgetWithText(OutlinedButton, 'Hold'), findsNothing);
        expect(
          find.widgetWithText(OutlinedButton, 'Return to Branch'),
          findsNothing,
        );
      },
    );

    testWidgets('a failed Hold shows an error safely and keeps prior state', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'out_for_delivery')],
      )..failNextAction = true;
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Hold'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Customer unreachable');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Hold'));
      await tester.pumpAndSettle();
      expect(find.text('Order placed on Hold.'), findsNothing);
      // No raw exception text, no crash — the same generic-failure snackbar
      // every other Driver action uses.
      expect(
        find.descendant(
          of: find.byType(SnackBar),
          matching: find.text('Data is currently unavailable.'),
        ),
        findsOneWidget,
      );
      // Still out_for_delivery — Hold is still offered, nothing corrupted.
      expect(find.widgetWithText(OutlinedButton, 'Hold'), findsOneWidget);
    });

    testWidgets('Return to Branch without a reason cannot be confirmed', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'out_for_delivery')],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Return to Branch'));
      await tester.pumpAndSettle();
      final confirmButton = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Return to Branch'),
      );
      expect(confirmButton.onPressed, isNull);
      expect(repository.changeStatusCalls, 0);
    });

    testWidgets('Return to Branch with a reason succeeds and refreshes', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'out_for_delivery')],
      );
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(OutlinedButton, 'Return to Branch'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Customer refused');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Return to Branch'));
      await tester.pumpAndSettle();
      expect(repository.changeStatusCalls, 1);
      expect(repository.lastStatusTarget, 'returned_to_branch');
      expect(repository.lastStatusReason, 'Customer refused');
      expect(find.text('Status updated.'), findsOneWidget);
      // Terminal-for-the-Driver after Return to Branch — no action buttons.
      expect(find.byType(FilledButton), findsNothing);
      expect(
        find.widgetWithText(OutlinedButton, 'Return to Branch'),
        findsNothing,
      );
    });

    testWidgets('a failed status change shows an error and keeps prior state', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'assigned_to_driver')],
      )..failNextAction = true;
      await tester.pumpWidget(
        _wrap(
          const DriverOrderDetailsPage(orderId: 'order-1'),
          repository: repository,
          user: _driverUser(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Start Delivery'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.widgetWithText(FilledButton, 'Start Delivery').last,
      );
      await tester.pumpAndSettle();
      expect(find.text('Delivery started.'), findsNothing);
      expect(
        find.descendant(
          of: find.byType(SnackBar),
          matching: find.text('Data is currently unavailable.'),
        ),
        findsOneWidget,
      );
      // Still assigned_to_driver — Start Delivery is still the only action.
      expect(
        find.widgetWithText(FilledButton, 'Start Delivery'),
        findsOneWidget,
      );
    });
  });

  group('DriverOrderDetailsPage — Order History', () {
    testWidgets(
      'is collapsed by default: rows absent and history() not yet called',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeDriverRepository(
          ordersResult: [_driverOrder(status: 'delivered')],
          historyResult: const [
            DriverOrderHistoryEvent(
              toStatus: 'assigned_to_driver',
              occurredAt: '2026-08-09T10:00:00Z',
            ),
          ],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        expect(repository.historyCalls, 0);
        expect(find.byIcon(Icons.history), findsNothing);
      },
    );

    testWidgets(
      'expanding calls history() exactly once and renders human-readable timestamps',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeDriverRepository(
          ordersResult: [_driverOrder(status: 'delivered')],
          historyResult: const [
            DriverOrderHistoryEvent(
              toStatus: 'assigned_to_driver',
              occurredAt: '2026-08-09T10:00:00Z',
            ),
            DriverOrderHistoryEvent(
              fromStatus: 'assigned_to_driver',
              toStatus: 'out_for_delivery',
              occurredAt: '2026-08-09T12:30:00Z',
            ),
          ],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Order History'));
        await tester.pumpAndSettle();
        expect(repository.historyCalls, 1);
        expect(find.byIcon(Icons.history), findsNWidgets(2));
        // Never a raw ISO timestamp string.
        expect(find.text('2026-08-09T10:00:00Z'), findsNothing);
        expect(find.text('2026-08-09T12:30:00Z'), findsNothing);
        expect(find.textContaining('2026'), findsWidgets);

        // Collapsing hides the rows again without re-fetching...
        await tester.tap(find.text('Order History'));
        await tester.pumpAndSettle();
        expect(repository.historyCalls, 1);
        expect(find.byIcon(Icons.history), findsNothing);
        // ...and expanding again shows them again, still without a second
        // network call.
        await tester.tap(find.text('Order History'));
        await tester.pumpAndSettle();
        expect(repository.historyCalls, 1);
        expect(find.byIcon(Icons.history), findsNWidgets(2));
      },
    );
  });

  group('DriverOrderDetailsPage — Back navigation', () {
    testWidgets('shows a Back control and popping returns to the Orders list', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeDriverRepository(
        ordersResult: [_driverOrder(status: 'assigned_to_driver')],
      );
      final router = GoRouter(
        initialLocation: '/orders',
        routes: [
          ShellRoute(
            builder: (_, state, child) =>
                RoleAwareShell(location: state.uri.path, child: child),
            routes: [
              GoRoute(
                path: '/dashboard',
                builder: (_, _) => const SizedBox.shrink(),
              ),
              GoRoute(
                path: '/orders',
                builder: (_, _) => const Text('driver-orders-list'),
              ),
              GoRoute(
                path: '/orders/:id',
                builder: (_, state) => DriverOrderDetailsPage(
                  orderId: state.pathParameters['id'] ?? '',
                ),
              ),
              GoRoute(
                path: '/messages',
                builder: (_, _) => const SizedBox.shrink(),
              ),
              GoRoute(
                path: '/notifications',
                builder: (_, _) => const SizedBox.shrink(),
              ),
              GoRoute(
                path: '/profile',
                builder: (_, _) => const SizedBox.shrink(),
              ),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            driverRepositoryProvider.overrideWithValue(repository),
            authenticationServiceProvider.overrideWithValue(
              _FakeAuthenticationService(
                AuthenticationState(
                  AuthenticationStatus.authenticated,
                  session: _sessionFor(_driverUser()),
                ),
              ),
            ),
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
      router.push('/orders/order-1');
      await tester.pumpAndSettle();
      expect(find.byType(BackButton), findsOneWidget);
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      expect(find.text('driver-orders-list'), findsOneWidget);
    });
  });

  group('DriverOrderDetailsPage — grouped card sections (redesign)', () {
    testWidgets(
      'renders Header, Customer, Delivery, Order, and Actions as distinct cards',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeDriverRepository(
          ordersResult: [_driverOrder(status: 'out_for_delivery')],
        );
        await tester.pumpWidget(
          _wrap(
            const DriverOrderDetailsPage(orderId: 'order-1'),
            repository: repository,
            user: _driverUser(),
          ),
        );
        await tester.pumpAndSettle();
        // Header card: Serial No., Reference, status chip.
        expect(find.byIcon(Icons.receipt_long_outlined), findsOneWidget);
        expect(find.text('SN-1001'), findsOneWidget);
        expect(find.byType(StatusChip), findsWidgets);
        // Customer card: Name, Mobile, Call.
        expect(find.byIcon(Icons.person_outline), findsOneWidget);
        expect(find.text('Customer A'), findsOneWidget);
        expect(
          find.widgetWithText(OutlinedButton, 'Call Customer'),
          findsOneWidget,
        );
        // Delivery card: Emirate, Area, Address, Open Map.
        expect(find.byIcon(Icons.location_on_outlined), findsOneWidget);
        expect(find.textContaining('Deira'), findsOneWidget);
        expect(find.widgetWithText(OutlinedButton, 'Open Map'), findsOneWidget);
        // Order card: Order Date, COD, Trader.
        expect(find.byIcon(Icons.inventory_2_outlined), findsOneWidget);
        expect(find.text('Plaza Store'), findsOneWidget);
        expect(find.textContaining('AED 100.00'), findsOneWidget);
        // Actions card: the shared status-action widget, its own card.
        expect(find.byIcon(Icons.touch_app_outlined), findsOneWidget);
        expect(find.widgetWithText(FilledButton, 'Delivered'), findsOneWidget);
        // Every section renders inside its own Material Card.
        expect(find.byType(Card), findsWidgets);
      },
    );
  });

  group('DriverStatusActionsCard — shared role-safe status-action widget', () {
    Widget wrapBare(Widget child) => MaterialApp(
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      home: Scaffold(body: child),
    );

    testWidgets(
      'renders exactly the buttons for the given action set, nothing more, '
      'and reports the tapped action back to the caller',
      (tester) async {
        final captured = <DriverAction>[];
        await tester.pumpWidget(
          wrapBare(
            DriverStatusActionsCard(
              actions: const {
                DriverAction.markDelivered,
                DriverAction.hold,
                DriverAction.returnToBranch,
              },
              busy: false,
              onAction: captured.add,
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(FilledButton, 'Delivered'), findsOneWidget);
        expect(find.widgetWithText(OutlinedButton, 'Hold'), findsOneWidget);
        expect(
          find.widgetWithText(OutlinedButton, 'Return to Branch'),
          findsOneWidget,
        );
        expect(
          find.widgetWithText(FilledButton, 'Start Delivery'),
          findsNothing,
        );
        await tester.tap(find.widgetWithText(OutlinedButton, 'Hold'));
        expect(captured, [DriverAction.hold]);
      },
    );

    testWidgets('renders nothing at all for an empty (terminal) action set', (
      tester,
    ) async {
      await tester.pumpWidget(
        wrapBare(
          DriverStatusActionsCard(
            actions: const {},
            busy: false,
            onAction: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(Card), findsNothing);
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(OutlinedButton), findsNothing);
    });
  });

  group(
    'Role safety — Trader never gets Driver or Operator status-action controls',
    () {
      testWidgets('TraderOrderDetailsPage renders no status-action buttons', (
        tester,
      ) async {
        await tester.pumpWidget(
          MaterialApp(
            supportedLocales: AppLocalizations.supportedLocales,
            localizationsDelegates: const [
              AppLocalizations.delegate,
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: const Scaffold(
              body: TraderOrderDetailsPage(orderId: 'order-1'),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byType(DriverStatusActionsCard), findsNothing);
        expect(find.widgetWithText(FilledButton, 'Delivered'), findsNothing);
        expect(find.widgetWithText(OutlinedButton, 'Hold'), findsNothing);
        expect(
          find.widgetWithText(OutlinedButton, 'Return to Branch'),
          findsNothing,
        );
        expect(
          find.widgetWithText(FilledButton, 'Start Delivery'),
          findsNothing,
        );
      });
    },
  );
}
