import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/features/dashboard/dashboard_page.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_models.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_pages.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_repository.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

/// An in-memory double for `OperatorRepository` — no network, no dio
/// mocking needed, since the interface itself is the seam.
final class FakeOperatorRepository implements OperatorRepository {
  FakeOperatorRepository({
    this.summaryResult,
    this.summaryError,
    OperatorOrder? detailResult,
    this.driversResult = const [],
  }) : detail_ = detailResult;
  OperatorDashboardSummary? summaryResult;
  Object? summaryError;
  OperatorOrder? detail_;
  List<OperatorDriver> driversResult;
  int assignCalls = 0;
  String? lastAssignedDriverId;
  int changeStatusCalls = 0;
  String? lastStatusTarget;
  String? lastStatusReason;
  bool failNextAction = false;

  @override
  Future<OperatorDashboardSummary> dashboardSummary() async {
    if (summaryError != null) throw summaryError!;
    return summaryResult!;
  }

  @override
  Future<OperatorOrderPage> orders({
    int page = 1,
    String? search,
    String? status,
  }) async =>
      const OperatorOrderPage(items: [], page: 1, pageSize: 25, totalCount: 0);

  @override
  Future<OperatorOrder> detail(String id) async => detail_!;

  @override
  Future<List<OperatorDriver>> drivers() async => driversResult;

  @override
  Future<void> assign(String orderId, String driverId) async {
    assignCalls += 1;
    lastAssignedDriverId = driverId;
    if (failNextAction) throw Exception('assign failed');
  }

  @override
  Future<void> changeStatus(
    String orderId,
    String status, {
    String? reason,
  }) async {
    changeStatusCalls += 1;
    lastStatusTarget = status;
    lastStatusReason = reason;
    if (failNextAction) throw Exception('status change failed');
  }
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

AuthenticatedUser _operatorUser({Set<String> permissions = const {}}) =>
    AuthenticatedUser(
      id: 'operator-1',
      companyId: 'company-1',
      displayName: 'Test Operator',
      roles: {UserRole.operatorRole},
      permissions: {
        'mobile.operator.access',
        'orders.assign_driver',
        'orders.update_delivery_status',
        ...permissions,
      },
      accessState: AccountAccessState.active,
    );

AuthenticatedSession _sessionFor(AuthenticatedUser user) =>
    AuthenticatedSession(
      user: user,
      expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
    );

Widget _wrap(
  Widget child, {
  required FakeOperatorRepository repository,
  required AuthenticatedUser user,
}) => ProviderScope(
  overrides: [
    operatorRepositoryProvider.overrideWithValue(repository),
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

void main() {
  group('OperatorDashboardSummary.fromJson (Prompt 12B)', () {
    test('parses a well-formed response', () {
      final summary = OperatorDashboardSummary.fromJson({
        'activeTotal': 5,
        'byStatus': {'new': 2, 'assigned_to_driver': 3},
        'deliveredToday': 1,
        'returnPending': 0,
      });
      expect(summary.activeTotal, 5);
      expect(summary.statusCount('new'), 2);
      expect(summary.deliveredToday, 1);
    });
    test('fails loud on a missing byStatus instead of defaulting silently', () {
      expect(
        () => OperatorDashboardSummary.fromJson({
          'activeTotal': 1,
          'deliveredToday': 0,
          'returnPending': 0,
        }),
        throwsA(isA<OperatorDashboardParseError>()),
      );
    });
    test('fails loud on a non-integer activeTotal', () {
      expect(
        () => OperatorDashboardSummary.fromJson({
          'activeTotal': '5',
          'byStatus': <String, dynamic>{},
          'deliveredToday': 0,
          'returnPending': 0,
        }),
        throwsA(isA<OperatorDashboardParseError>()),
      );
    });
  });

  group('operatorDashboardCards (Prompt 12B)', () {
    test(
      'maps the summary to exactly 6 cards with the correct values and deep links',
      () async {
        final l10n = await AppLocalizations.delegate.load(const Locale('en'));
        const summary = OperatorDashboardSummary(
          activeTotal: 12,
          byStatus: {'new': 3, 'assigned_to_driver': 4, 'out_for_delivery': 2},
          deliveredToday: 6,
          returnPending: 1,
        );
        final cards = operatorDashboardCards(summary, l10n);
        expect(cards, hasLength(6));
        expect(cards[0].value, 12);
        expect(cards[0].route, '/orders');
        expect(cards[1].title, l10n.newStatus);
        expect(cards[1].value, 3);
        expect(cards[1].route, '/orders?deliveryStatus=new');
        expect(cards[2].route, '/orders?deliveryStatus=assigned_to_driver');
        expect(cards[3].route, '/orders?deliveryStatus=out_for_delivery');
        expect(cards[4].value, 6);
        expect(cards[4].route, '/orders?deliveryStatus=delivered');
        expect(cards[5].value, 1);
        expect(cards[5].route, '/orders?deliveryStatus=returned_to_branch');
        // "Active" never silently double-counts Cancelled — it is not one of
        // the 6 cards at all, matching the established quickView boundary.
        expect(cards.map((c) => c.title), isNot(contains(l10n.cancelled)));
      },
    );
  });

  group('RoleDashboardPage — Operator (Prompt 12B)', () {
    testWidgets('shows a loading skeleton, then real counts', (tester) async {
      final repository = FakeOperatorRepository(
        summaryResult: const OperatorDashboardSummary(
          activeTotal: 7,
          byStatus: {'new': 2},
          deliveredToday: 1,
          returnPending: 0,
        ),
      );
      await tester.pumpWidget(
        _wrap(
          const RoleDashboardPage(),
          repository: repository,
          user: _operatorUser(),
        ),
      );
      await tester.pump();
      expect(find.byType(DashboardSkeleton), findsOneWidget);
      await tester.pumpAndSettle();
      expect(find.text('7'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
    });

    testWidgets('shows a retryable error state when the summary call fails', (
      tester,
    ) async {
      final repository = FakeOperatorRepository(
        summaryError: Exception('boom'),
      );
      await tester.pumpWidget(
        _wrap(
          const RoleDashboardPage(),
          repository: repository,
          user: _operatorUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(TextButton), findsWidgets);
      repository.summaryResult = const OperatorDashboardSummary(
        activeTotal: 1,
        byStatus: {},
        deliveredToday: 0,
        returnPending: 0,
      );
      repository.summaryError = null;
      await tester.tap(find.byType(TextButton).first);
      await tester.pumpAndSettle();
      expect(find.text('1'), findsWidgets);
    });

    testWidgets('tapping a card navigates to the filtered Orders route', (
      tester,
    ) async {
      final repository = FakeOperatorRepository(
        summaryResult: const OperatorDashboardSummary(
          activeTotal: 7,
          byStatus: {'new': 2},
          deliveredToday: 0,
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
            builder: (_, state) => Scaffold(body: Text('orders:${state.uri}')),
          ),
        ],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            operatorRepositoryProvider.overrideWithValue(repository),
            authenticationServiceProvider.overrideWithValue(
              _FakeAuthenticationService(
                AuthenticationState(
                  AuthenticationStatus.authenticated,
                  session: _sessionFor(_operatorUser()),
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
      await tester.tap(find.text('New'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('orders:/orders?deliveryStatus=new'),
        findsOneWidget,
      );
    });
  });

  group(
    'OperatorOrderDetailsPage — status actions and reassignment (Prompt 12B)',
    () {
      OperatorOrder order({
        required String status,
        String? driverId,
        String? driverName,
      }) => OperatorOrder(
        id: 'order-1',
        orderNumber: 'ORD-1',
        serialNumber: 'SN-1001',
        orderDate: '2026-01-01',
        traderName: 'Trader A',
        customerName: 'Customer A',
        customerMobile: '971500000000',
        address: 'Address',
        areaName: 'Area',
        cod: '100.00',
        status: status,
        driverId: driverId,
        driverName: driverName,
      );

      testWidgets(
        'a New Order offers Assign Driver and no status-action button',
        (tester) async {
          final repository = FakeOperatorRepository(
            detailResult: order(status: 'new'),
          );
          await tester.pumpWidget(
            _wrap(
              const OperatorOrderDetailsPage(orderId: 'order-1'),
              repository: repository,
              user: _operatorUser(),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.text('Assign Driver'), findsOneWidget);
          expect(find.text('Reassign Driver'), findsNothing);
          // 'New' can only move to Cancelled directly — the button is offered,
          // but confirming it demands a reason (asserted separately below).
          expect(
            find.widgetWithText(OutlinedButton, 'Cancelled'),
            findsOneWidget,
          );
          expect(
            find.widgetWithText(OutlinedButton, 'Out for Delivery'),
            findsNothing,
          );
        },
      );

      testWidgets(
        'an Assigned Order offers Reassign and Out for Delivery, not Assign',
        (tester) async {
          final repository = FakeOperatorRepository(
            detailResult: order(
              status: 'assigned_to_driver',
              driverId: 'driver-1',
              driverName: 'Driver A',
            ),
            driversResult: const [
              OperatorDriver(
                id: 'driver-2',
                name: 'Driver B',
                status: 'active',
                type: 'employee',
                activeOrders: 0,
              ),
            ],
          );
          await tester.pumpWidget(
            _wrap(
              const OperatorOrderDetailsPage(orderId: 'order-1'),
              repository: repository,
              user: _operatorUser(),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.text('Assign Driver'), findsNothing);
          expect(find.text('Reassign Driver'), findsOneWidget);
          expect(
            find.widgetWithText(OutlinedButton, 'Out for Delivery'),
            findsOneWidget,
          );
        },
      );

      testWidgets(
        'reassigning calls the repository with the newly selected Driver',
        (tester) async {
          final repository = FakeOperatorRepository(
            detailResult: order(
              status: 'assigned_to_driver',
              driverId: 'driver-1',
              driverName: 'Driver A',
            ),
            driversResult: const [
              OperatorDriver(
                id: 'driver-2',
                name: 'Driver B',
                status: 'active',
                type: 'employee',
                activeOrders: 0,
              ),
            ],
          );
          await tester.pumpWidget(
            _wrap(
              const OperatorOrderDetailsPage(orderId: 'order-1'),
              repository: repository,
              user: _operatorUser(),
            ),
          );
          await tester.pumpAndSettle();
          await tester.tap(find.text('Reassign Driver'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Driver B'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Reassign Driver').last);
          await tester.pumpAndSettle();
          expect(repository.assignCalls, 1);
          expect(repository.lastAssignedDriverId, 'driver-2');
          expect(find.text('Driver reassigned.'), findsOneWidget);
        },
      );

      testWidgets(
        'a status change requiring a reason cannot be confirmed with an empty reason',
        (tester) async {
          final repository = FakeOperatorRepository(
            detailResult: order(
              status: 'out_for_delivery',
              driverId: 'driver-1',
              driverName: 'Driver A',
            ),
          );
          await tester.pumpWidget(
            _wrap(
              const OperatorOrderDetailsPage(orderId: 'order-1'),
              repository: repository,
              user: _operatorUser(),
            ),
          );
          await tester.pumpAndSettle();
          await tester.tap(find.widgetWithText(OutlinedButton, 'Cancelled'));
          await tester.pumpAndSettle();
          final confirmButton = tester.widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Change Status'),
          );
          expect(confirmButton.onPressed, isNull);
          expect(repository.changeStatusCalls, 0);
        },
      );

      testWidgets(
        'a successful status change refreshes the Order and shows confirmation',
        (tester) async {
          final repository = FakeOperatorRepository(
            detailResult: order(
              status: 'out_for_delivery',
              driverId: 'driver-1',
              driverName: 'Driver A',
            ),
          );
          await tester.pumpWidget(
            _wrap(
              const OperatorOrderDetailsPage(orderId: 'order-1'),
              repository: repository,
              user: _operatorUser(),
            ),
          );
          await tester.pumpAndSettle();
          await tester.tap(find.widgetWithText(OutlinedButton, 'Delivered'));
          await tester.pumpAndSettle();
          await tester.tap(find.widgetWithText(FilledButton, 'Change Status'));
          await tester.pumpAndSettle();
          expect(repository.changeStatusCalls, 1);
          expect(repository.lastStatusTarget, 'delivered');
          expect(find.text('Status updated.'), findsOneWidget);
        },
      );

      testWidgets(
        'a failed status change shows an error and does not silently succeed',
        (tester) async {
          final repository = FakeOperatorRepository(
            detailResult: order(
              status: 'out_for_delivery',
              driverId: 'driver-1',
              driverName: 'Driver A',
            ),
          )..failNextAction = true;
          await tester.pumpWidget(
            _wrap(
              const OperatorOrderDetailsPage(orderId: 'order-1'),
              repository: repository,
              user: _operatorUser(),
            ),
          );
          await tester.pumpAndSettle();
          await tester.tap(find.widgetWithText(OutlinedButton, 'Delivered'));
          await tester.pumpAndSettle();
          await tester.tap(find.widgetWithText(FilledButton, 'Change Status'));
          await tester.pumpAndSettle();
          expect(find.text('Status updated.'), findsNothing);
          expect(
            find.descendant(
              of: find.byType(SnackBar),
              matching: find.text('Data is currently unavailable.'),
            ),
            findsOneWidget,
          );
        },
      );

      testWidgets(
        'plain Operator presentation never offers Hold, even now that a '
        'genuine Driver can reach it — Operator status actions are '
        'completely unaffected by the Driver-presentation Hold fix',
        (tester) async {
          final repository = FakeOperatorRepository(
            detailResult: order(
              status: 'out_for_delivery',
              driverId: 'driver-1',
              driverName: 'Driver A',
            ),
          );
          await tester.pumpWidget(
            _wrap(
              const OperatorOrderDetailsPage(orderId: 'order-1'),
              repository: repository,
              user: _operatorUser(),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.text('Hold'), findsNothing);
          expect(
            find.widgetWithText(OutlinedButton, 'Delivered'),
            findsOneWidget,
          );
          expect(
            find.widgetWithText(OutlinedButton, 'Returned to Branch'),
            findsOneWidget,
          );
        },
      );

      testWidgets(
        'a Delivered Order (terminal for the Operator) offers no status action',
        (tester) async {
          final repository = FakeOperatorRepository(
            detailResult: order(
              status: 'delivered',
              driverId: 'driver-1',
              driverName: 'Driver A',
            ),
          );
          await tester.pumpWidget(
            _wrap(
              const OperatorOrderDetailsPage(orderId: 'order-1'),
              repository: repository,
              user: _operatorUser(),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.text('Actions'), findsNothing);
          expect(find.text('Assign Driver'), findsNothing);
          expect(find.text('Reassign Driver'), findsNothing);
        },
      );
    },
  );

  group(
    'Role safety — a non-Operator identity never gains Operator-only actions (Prompt 12B)',
    () {
      test(
        'operatorOrderPermissions never implicitly grants status-change or assignment',
        () {
          // A Trader/Driver/Customer identity can never hold these codes by
          // construction (they are Company-user-only permissions on the
          // backend); this asserts the mobile side does not invent a bypass.
          expect(hasOperatorOrderAccess({'trader.something'}), isFalse);
          expect(hasOperatorOrderAccess(<String>{}), isFalse);
        },
      );
    },
  );
}
