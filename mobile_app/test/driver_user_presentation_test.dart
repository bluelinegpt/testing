import 'dart:async';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/services/driver_sync_controller.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:bluelinegpt_mobile/features/common/pages.dart';
import 'package:bluelinegpt_mobile/features/dashboard/dashboard_page.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_cache_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_sync_queue_repository.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_models.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_pages.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_repository.dart';
import 'package:bluelinegpt_mobile/features/trader/trader_pages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Proves a Driver User's dashboard never reaches the driver-portal
/// dashboard-summary endpoint — a `company_user` identity would get a 403
/// from `/portal/driver/*`, so a correct Driver User session must never call
/// any of these either. Mirrors `_CountingOperatorRepository` in
/// `driver_dashboard_and_detail_test.dart`.
final class _CountingDriverRepository implements DriverRepository {
  int dashboardSummaryCalls = 0;
  @override
  Future<DriverDashboardSummary> dashboardSummary() async {
    dashboardSummaryCalls += 1;
    throw UnimplementedError('Driver User session must never call this');
  }

  @override
  Future<DriverOrder> changeStatus(
    String orderId,
    String status,
    String idempotencyKey, {
    String? reason,
    String? expectedStatus,
  }) => throw UnimplementedError();
  @override
  Future<List<DriverOrderHistoryEvent>> history(String orderId) =>
      throw UnimplementedError();
  @override
  Future<List<DriverOrder>> orders() => throw UnimplementedError();
}

final class FakeOperatorRepository implements OperatorRepository {
  FakeOperatorRepository({this.summaryResult, OperatorOrder? detailResult})
    : detail_ = detailResult;
  OperatorDashboardSummary? summaryResult;
  OperatorOrder? detail_;
  int changeStatusCalls = 0;
  String? lastStatusTarget;
  bool failNextAction = false;

  @override
  Future<OperatorDashboardSummary> dashboardSummary() async => summaryResult!;
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
  Future<List<OperatorDriver>> drivers() async => const [];
  @override
  Future<void> assign(String orderId, String driverId) async {}
  @override
  Future<void> changeStatus(
    String orderId,
    String status, {
    String? reason,
  }) async {
    changeStatusCalls += 1;
    lastStatusTarget = status;
    if (failNextAction) throw Exception('status change failed');
  }
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

/// A `logout()` that stays pending until the test explicitly completes it —
/// lets a test observe the busy/loading state a real slow network call would
/// produce, without an actual delay.
final class _DelayedLogoutAuthenticationService
    implements AuthenticationService {
  _DelayedLogoutAuthenticationService(this.state);
  final AuthenticationState state;
  final logoutStarted = Completer<void>();
  final _logoutGate = Completer<void>();
  int logoutCalls = 0;
  @override
  Future<AuthenticationState> restore() async => state;
  @override
  Future<AuthenticationState> login(LoginInput input) async => state;
  @override
  Future<void> logout() async {
    logoutCalls++;
    if (!logoutStarted.isCompleted) logoutStarted.complete();
    await _logoutGate.future;
  }

  void completeLogout() {
    if (!_logoutGate.isCompleted) _logoutGate.complete();
  }

  @override
  Future<String?> changePassword(
    String currentPassword,
    String newPassword,
  ) async => null;
}

AuthenticatedUser _driverUserUser({String linkedDriverId = 'driver-99'}) =>
    AuthenticatedUser(
      id: 'company-user-1',
      companyId: 'company-1',
      displayName: 'D123',
      roles: {UserRole.operatorRole},
      permissions: {
        'mobile.operator.access',
        'orders.assign_driver',
        'orders.update_delivery_status',
      },
      accessState: AccountAccessState.active,
      linkedDriverId: linkedDriverId,
    );

/// The exact real-world D123 shape: a Driver User whose Role holds NO
/// `orders.update_delivery_status`/`users_roles.manage` at all — only
/// `orders.assign_driver` (from an unrelated grant). This is the actual
/// permission set found on the physical device that had no visible status
/// actions at all: the backend now authorizes a Driver User acting on their
/// OWN Order via ownership alone (`currentEmployeeDriverId`), never
/// requiring this permission — mobile must not re-impose a stricter gate
/// than the backend actually enforces.
AuthenticatedUser _driverUserUserWithoutStatusPermission({
  String linkedDriverId = 'driver-99',
}) => AuthenticatedUser(
  id: 'company-user-1',
  companyId: 'company-1',
  displayName: 'D123',
  roles: {UserRole.operatorRole},
  permissions: {'mobile.operator.access', 'orders.assign_driver'},
  accessState: AccountAccessState.active,
  linkedDriverId: linkedDriverId,
);

AuthenticatedUser _plainOperatorUser() => AuthenticatedUser(
  id: 'operator-1',
  companyId: 'company-1',
  displayName: 'Test Operator',
  roles: {UserRole.operatorRole},
  permissions: {
    'mobile.operator.access',
    'orders.assign_driver',
    'orders.update_delivery_status',
  },
  accessState: AccountAccessState.active,
);

AuthenticatedUser _genuineDriverUser() => AuthenticatedUser(
  id: 'driver-account-1',
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

Widget _wrapDashboard(
  Widget child, {
  required FakeOperatorRepository operatorRepository,
  required AuthenticatedUser user,
  DriverRepository? driverRepository,
}) => ProviderScope(
  overrides: [
    operatorRepositoryProvider.overrideWithValue(operatorRepository),
    if (driverRepository != null)
      driverRepositoryProvider.overrideWithValue(driverRepository),
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

/// `OperatorOrderDetailsPage` renders more field rows than fit the default
/// 800×600 test surface — mirrors `_useTallViewport` in
/// `driver_dashboard_and_detail_test.dart`.
void _useTallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

OperatorOrder _driverUserOrder({
  String status = 'out_for_delivery',
  String? driverId = 'driver-99',
  List<OperatorOrderEvent> history = const [],
}) => OperatorOrder(
  id: 'order-1',
  orderNumber: 'ORD-000038',
  serialNumber: 'SN-2001',
  orderDate: '2026-08-09',
  traderName: 'Plaza Store',
  customerName: 'Customer A',
  customerMobile: '971500000000',
  address: '123 Main Street',
  areaName: 'Deira',
  cod: '150.00',
  status: status,
  reference: 'REF-55',
  driverId: driverId,
  driverName: driverId == null ? null : 'D123',
  emirateNameEn: 'Dubai',
  emirateNameAr: 'دبي',
  history: history,
);

void main() {
  group('AuthenticatedUser.isDriverPresentation', () {
    test('a genuine driver-kind account resolves true', () {
      expect(_genuineDriverUser().isDriverPresentation, isTrue);
    });
    test(
      'a company_user with a resolved linkedDriverId (Driver User) resolves true',
      () {
        expect(_driverUserUser().isDriverPresentation, isTrue);
      },
    );
    test('a plain Operator (no linkedDriverId) resolves false', () {
      expect(_plainOperatorUser().isDriverPresentation, isFalse);
    });
  });

  group('roleLabel (shared, Profile + Dashboard)', () {
    test('a Driver User displays the Driver label, never Operator', () async {
      final l10n = await AppLocalizations.delegate.load(const Locale('en'));
      expect(roleLabel(_driverUserUser(), l10n), l10n.driver);
      expect(roleLabel(_driverUserUser(), l10n), isNot(l10n.operator));
    });
    test('a plain Operator still displays the Operator label', () async {
      final l10n = await AppLocalizations.delegate.load(const Locale('en'));
      expect(roleLabel(_plainOperatorUser(), l10n), l10n.operator);
    });
  });

  group('AccountPage — Driver User Profile label', () {
    testWidgets('shows "Driver", authoritatively, for a Driver User', (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authenticationServiceProvider.overrideWithValue(
              _FakeAuthenticationService(
                AuthenticationState(
                  AuthenticationStatus.authenticated,
                  session: _sessionFor(_driverUserUser()),
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
            home: const Scaffold(body: AccountPage()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Driver'), findsOneWidget);
      expect(find.text('Operator'), findsNothing);
    });
  });

  group('Company name — Dashboard + Account page', () {
    AuthenticatedUser withCompany({String? companyNameAr}) => AuthenticatedUser(
      id: 'company-user-1',
      companyId: 'company-1',
      displayName: 'D123',
      roles: {UserRole.operatorRole},
      permissions: {'mobile.operator.access', 'orders.update_delivery_status'},
      accessState: AccountAccessState.active,
      companyName: 'Operator Mobile Co',
      companyNameAr: companyNameAr,
    );
    AuthenticatedUser withoutCompany() => AuthenticatedUser(
      id: 'company-user-2',
      companyId: 'company-1',
      displayName: 'No Company Name',
      roles: {UserRole.operatorRole},
      permissions: {'mobile.operator.access', 'orders.update_delivery_status'},
      accessState: AccountAccessState.active,
    );

    testWidgets('Dashboard shows the Company name when present', (
      tester,
    ) async {
      final operatorRepository = FakeOperatorRepository(
        summaryResult: const OperatorDashboardSummary(
          activeTotal: 0,
          byStatus: {},
          deliveredToday: 0,
          returnPending: 0,
        ),
      );
      await tester.pumpWidget(
        _wrapDashboard(
          const RoleDashboardPage(),
          operatorRepository: operatorRepository,
          user: withCompany(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Operator Mobile Co'), findsOneWidget);
    });

    testWidgets(
      'Dashboard shows nothing extra when the Company name is absent',
      (tester) async {
        final operatorRepository = FakeOperatorRepository(
          summaryResult: const OperatorDashboardSummary(
            activeTotal: 0,
            byStatus: {},
            deliveredToday: 0,
            returnPending: 0,
          ),
        );
        await tester.pumpWidget(
          _wrapDashboard(
            const RoleDashboardPage(),
            operatorRepository: operatorRepository,
            user: withoutCompany(),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Operator Mobile Co'), findsNothing);
      },
    );

    testWidgets('Account page shows a Company row when present', (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authenticationServiceProvider.overrideWithValue(
              _FakeAuthenticationService(
                AuthenticationState(
                  AuthenticationStatus.authenticated,
                  session: _sessionFor(withCompany()),
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
            home: const Scaffold(body: AccountPage()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Company'), findsOneWidget);
      expect(find.text('Operator Mobile Co'), findsOneWidget);
    });

    testWidgets('Account page omits the Company row when absent', (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authenticationServiceProvider.overrideWithValue(
              _FakeAuthenticationService(
                AuthenticationState(
                  AuthenticationStatus.authenticated,
                  session: _sessionFor(withoutCompany()),
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
            home: const Scaffold(body: AccountPage()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Company'), findsNothing);
    });

    test(
      'Arabic locale prefers companyNameAr, falls back to English when absent',
      () {
        expect(
          companyDisplayName(
            withCompany(companyNameAr: 'شركة تشغيل المشغل'),
            'ar',
          ),
          'شركة تشغيل المشغل',
        );
        // No Arabic name set — falls back to the English one rather than
        // showing nothing.
        expect(companyDisplayName(withCompany(), 'ar'), 'Operator Mobile Co');
        expect(companyDisplayName(withoutCompany(), 'ar'), isNull);
      },
    );
  });

  group('RoleDashboardPage — Driver User (Prompt: Driver User correction)', () {
    testWidgets(
      'selects the Operator repository/endpoint, never the driver-portal one',
      (tester) async {
        final operatorRepository = FakeOperatorRepository(
          summaryResult: const OperatorDashboardSummary(
            activeTotal: 2,
            byStatus: {
              'new': 0,
              'assigned_to_driver': 0,
              'out_for_delivery': 2,
              'delivered': 0,
              'returned_to_branch': 0,
              'cancelled': 0,
            },
            deliveredToday: 0,
            returnPending: 0,
          ),
        );
        final driverRepository = _CountingDriverRepository();
        await tester.pumpWidget(
          _wrapDashboard(
            const RoleDashboardPage(),
            operatorRepository: operatorRepository,
            driverRepository: driverRepository,
            user: _driverUserUser(),
          ),
        );
        await tester.pumpAndSettle();
        expect(driverRepository.dashboardSummaryCalls, 0);
      },
    );

    testWidgets(
      'renders the 5-card Driver-style layout (no "New" card) derived from '
      'the Operator summary\'s byStatus',
      (tester) async {
        final l10n = await AppLocalizations.delegate.load(const Locale('en'));
        final operatorRepository = FakeOperatorRepository(
          summaryResult: const OperatorDashboardSummary(
            activeTotal: 2,
            byStatus: {'assigned_to_driver': 1, 'out_for_delivery': 1},
            deliveredToday: 0,
            returnPending: 0,
          ),
        );
        await tester.pumpWidget(
          _wrapDashboard(
            const RoleDashboardPage(),
            operatorRepository: operatorRepository,
            user: _driverUserUser(),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text(l10n.myActiveOrders), findsOneWidget);
        expect(find.text(l10n.assignedToMe), findsOneWidget);
        expect(find.text(l10n.outForDelivery), findsOneWidget);
        expect(find.text(l10n.deliveredToday), findsOneWidget);
        expect(find.text(l10n.returnPending), findsOneWidget);
        expect(find.text(l10n.newStatus), findsNothing);
        expect(find.text(l10n.totalActiveOrders), findsNothing);
      },
    );

    testWidgets(
      'card counts reflect exactly the server-narrowed summary given — never '
      'recomputed or leaked client-side',
      (tester) async {
        // A deliberately narrow, already-server-scoped summary (as
        // `operatorDashboardSummary()` now returns for a Driver User) — if
        // the widget ever recomputed/inflated a total instead of reading
        // `summary` verbatim, these exact values would not match.
        final operatorRepository = FakeOperatorRepository(
          summaryResult: const OperatorDashboardSummary(
            activeTotal: 2,
            byStatus: {
              'new': 0,
              'assigned_to_driver': 0,
              'out_for_delivery': 2,
              'delivered': 0,
              'returned_to_branch': 0,
              'cancelled': 0,
            },
            deliveredToday: 0,
            returnPending: 0,
          ),
        );
        await tester.pumpWidget(
          _wrapDashboard(
            const RoleDashboardPage(),
            operatorRepository: operatorRepository,
            user: _driverUserUser(),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('2'), findsNWidgets(2)); // activeTotal, outForDelivery
        expect(find.text('0'), findsNWidgets(3));
      },
    );
  });

  group('RoleOrdersPage — Driver User routes through the Operator list', () {
    testWidgets(
      'a Driver User (company_user) still resolves OperatorOrdersPage, not '
      'DriverOrdersPage (regression — the Orders list already worked '
      'correctly pre-fix because the server narrows operations/orders too)',
      (tester) async {
        final operatorRepository = FakeOperatorRepository();
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              operatorRepositoryProvider.overrideWithValue(operatorRepository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUserUser()),
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
              home: const Scaffold(body: RoleOrdersPage()),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byType(OperatorOrdersPage), findsOneWidget);
      },
    );
  });

  group('OperatorOrderDetailsPage — driver presentation mode (Driver User)', () {
    testWidgets(
      'renders Serial Number, Reference, Order Date, Emirate, Area, and Address',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeOperatorRepository(
          detailResult: _driverUserOrder(),
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              operatorRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUserUser()),
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
              home: Scaffold(
                body: const OperatorOrderDetailsPage(
                  orderId: 'order-1',
                  driverPresentation: true,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('SN-2001'), findsOneWidget);
        expect(find.text('REF-55'), findsOneWidget);
        expect(find.text('09 Aug 2026'), findsOneWidget);
        expect(find.textContaining('Dubai'), findsOneWidget);
        expect(find.textContaining('Deira'), findsOneWidget);
        expect(find.textContaining('123 Main Street'), findsOneWidget);
        // The internal order number never appears as the primary heading —
        // it may still legitimately appear as secondary/debug info, so this
        // only asserts the primary fields render, not the absence of
        // `ORD-000038` outright.
      },
    );

    testWidgets(
      'never renders Assign Driver, even for an unassigned New Order that '
      'would show it in normal Operator presentation',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeOperatorRepository(
          detailResult: _driverUserOrder(
            status: 'new',
            driverId: null,
            history: const [],
          ),
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              operatorRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUserUser()),
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
              home: const Scaffold(
                body: OperatorOrderDetailsPage(
                  orderId: 'order-1',
                  driverPresentation: true,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.textContaining('Assign Driver'), findsNothing);
        expect(find.textContaining('Reassign Driver'), findsNothing);
      },
    );

    testWidgets(
      'an Out for Delivery Order offers Delivered / Hold / Return to Branch '
      'using the same Driver-scoped semantics as a genuine Driver, and calls '
      'the Operator changeStatus endpoint (never the driver-portal one)',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeOperatorRepository(
          detailResult: _driverUserOrder(status: 'out_for_delivery'),
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              operatorRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUserUser()),
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
              home: const Scaffold(
                body: OperatorOrderDetailsPage(
                  orderId: 'order-1',
                  driverPresentation: true,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        // Delivered/Hold/Return to Branch — exactly `actionsForDriverStatus`
        // for `out_for_delivery`, never the Operator's own broader set
        // (which would also offer Cancelled here, and never Hold).
        expect(find.widgetWithText(FilledButton, 'Delivered'), findsOneWidget);
        expect(find.widgetWithText(OutlinedButton, 'Hold'), findsOneWidget);
        expect(
          find.widgetWithText(OutlinedButton, 'Return to Branch'),
          findsOneWidget,
        );
        expect(find.text('Cancelled'), findsNothing);
        await tester.tap(find.widgetWithText(FilledButton, 'Delivered'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Delivered').last);
        await tester.pumpAndSettle();
        expect(repository.changeStatusCalls, 1);
        expect(repository.lastStatusTarget, 'delivered');
        expect(find.text('Status updated.'), findsOneWidget);
      },
    );

    testWidgets(
      'the exact D123 physical-device shape — a Driver User whose Role '
      'holds NO orders.update_delivery_status permission at all — still '
      'sees Delivered / Hold / Return to Branch on an Out for Delivery '
      'Order (this was the actual root cause: mobile was gating these '
      'buttons on the Operator permission the backend never requires for '
      'a Driver User acting on their own Order)',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeOperatorRepository(
          detailResult: _driverUserOrder(status: 'out_for_delivery'),
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              operatorRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(
                      _driverUserUserWithoutStatusPermission(),
                    ),
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
              home: const Scaffold(
                body: OperatorOrderDetailsPage(
                  orderId: 'order-1',
                  driverPresentation: true,
                ),
              ),
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
      },
    );

    testWidgets('an Assigned to Driver Order offers Start Delivery only', (
      tester,
    ) async {
      _useTallViewport(tester);
      final repository = FakeOperatorRepository(
        detailResult: _driverUserOrder(status: 'assigned_to_driver'),
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            operatorRepositoryProvider.overrideWithValue(repository),
            authenticationServiceProvider.overrideWithValue(
              _FakeAuthenticationService(
                AuthenticationState(
                  AuthenticationStatus.authenticated,
                  session: _sessionFor(_driverUserUser()),
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
            home: const Scaffold(
              body: OperatorOrderDetailsPage(
                orderId: 'order-1',
                driverPresentation: true,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.widgetWithText(FilledButton, 'Start Delivery'),
        findsOneWidget,
      );
      expect(find.text('Delivered'), findsNothing);
      expect(find.text('Hold'), findsNothing);
      expect(find.text('Return to Branch'), findsNothing);
    });

    testWidgets(
      'a terminal status (Delivered) offers no Driver status actions',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeOperatorRepository(
          detailResult: _driverUserOrder(
            status: 'delivered',
            history: const [],
          ),
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              operatorRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUserUser()),
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
              home: const Scaffold(
                body: OperatorOrderDetailsPage(
                  orderId: 'order-1',
                  driverPresentation: true,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        // `find.text('Delivered')` alone would also match the status chip
        // (the Order's current status legitimately reads "Delivered" there)
        // — these assertions target the Actions card's buttons specifically.
        expect(
          find.widgetWithText(FilledButton, 'Start Delivery'),
          findsNothing,
        );
        expect(find.widgetWithText(FilledButton, 'Delivered'), findsNothing);
        expect(find.widgetWithText(OutlinedButton, 'Hold'), findsNothing);
        expect(
          find.widgetWithText(OutlinedButton, 'Return to Branch'),
          findsNothing,
        );
      },
    );

    testWidgets(
      'a backend failure on a Driver action shows a safe error, never a '
      'raw exception, and does not silently succeed',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeOperatorRepository(
          detailResult: _driverUserOrder(status: 'out_for_delivery'),
        )..failNextAction = true;
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              operatorRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUserUser()),
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
              home: const Scaffold(
                body: OperatorOrderDetailsPage(
                  orderId: 'order-1',
                  driverPresentation: true,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Delivered'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Delivered').last);
        await tester.pumpAndSettle();
        expect(find.text('Order placed on Hold.'), findsNothing);
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
      'Hold requires a reason and, on success, shows the explicit Hold '
      'confirmation message',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeOperatorRepository(
          detailResult: _driverUserOrder(status: 'out_for_delivery'),
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              operatorRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUserUser()),
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
              home: const Scaffold(
                body: OperatorOrderDetailsPage(
                  orderId: 'order-1',
                  driverPresentation: true,
                ),
              ),
            ),
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
        await tester.enterText(find.byType(TextField), 'Parcel damaged');
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Hold'));
        await tester.pumpAndSettle();
        expect(repository.changeStatusCalls, 1);
        expect(repository.lastStatusTarget, 'hold');
        expect(find.text('Order placed on Hold.'), findsOneWidget);
      },
    );

    testWidgets(
      'Order History is collapsed initially with its count shown, expands on '
      'tap, and collapses again on a second tap',
      (tester) async {
        _useTallViewport(tester);
        final repository = FakeOperatorRepository(
          detailResult: _driverUserOrder(
            status: 'delivered',
            history: const [
              OperatorOrderEvent(
                status: 'assigned_to_driver',
                occurredAt: '2026-08-09 20:00:00.000000+04',
              ),
              OperatorOrderEvent(
                status: 'out_for_delivery',
                fromStatus: 'assigned_to_driver',
                occurredAt: '2026-08-09 23:16:36.456872+04',
              ),
            ],
          ),
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              operatorRepositoryProvider.overrideWithValue(repository),
              authenticationServiceProvider.overrideWithValue(
                _FakeAuthenticationService(
                  AuthenticationState(
                    AuthenticationStatus.authenticated,
                    session: _sessionFor(_driverUserUser()),
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
              home: const Scaffold(
                body: OperatorOrderDetailsPage(
                  orderId: 'order-1',
                  driverPresentation: true,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Order History (2)'), findsOneWidget);
        expect(find.byIcon(Icons.history), findsNothing);
        // Never a raw ISO/debug timestamp visible anywhere on the page.
        expect(find.text('2026-08-09 23:16:36.456872+04'), findsNothing);

        await tester.tap(find.text('Order History (2)'));
        await tester.pumpAndSettle();
        expect(find.byIcon(Icons.history), findsNWidgets(2));
        expect(find.textContaining('2026'), findsWidgets);
        expect(find.text('2026-08-09 23:16:36.456872+04'), findsNothing);

        await tester.tap(find.text('Order History (2)'));
        await tester.pumpAndSettle();
        expect(find.byIcon(Icons.history), findsNothing);
      },
    );
  });

  group('AccountPage — Logout busy state', () {
    testWidgets(
      'disables the button and shows a spinner from confirm until logout '
      'resolves, then re-enables it',
      (tester) async {
        _useTallViewport(tester);
        final delayedAuth = _DelayedLogoutAuthenticationService(
          AuthenticationState(
            AuthenticationStatus.authenticated,
            session: _sessionFor(_plainOperatorUser()),
          ),
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              authenticationServiceProvider.overrideWithValue(delayedAuth),
              driverSyncControllerProvider.overrideWithValue(
                DriverSyncController(
                  api: _CountingDriverRepository(),
                  cache: _NoopDriverOfflineCacheRepository(),
                  queue: _NoopDriverSyncQueueRepository(),
                  errorMapper: const ApiErrorMapper(),
                  logger: _NoopLogger(),
                  currentUser: () => null,
                  onSyncCompleted: () {},
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
              home: const Scaffold(body: AccountPage()),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('logoutButton')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Log out').last);
        // A single pump — not pumpAndSettle — to observe the in-flight busy
        // state before `logout()` resolves.
        await tester.pump();
        await delayedAuth.logoutStarted.future;
        await tester.pump();
        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        final button = tester.widget<FilledButton>(
          find.byKey(const Key('logoutButton')),
        );
        expect(button.onPressed, isNull);
        delayedAuth.completeLogout();
        await tester.pumpAndSettle();
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(delayedAuth.logoutCalls, 1);
      },
    );
  });
}

final class _NoopLogger implements AppLogger {
  @override
  void info(String event) {}
  @override
  void warning(String event, [Object? error]) {}
  @override
  void error(String event, Object error, StackTrace stack) {}
}

/// Never actually invoked (`pause()` alone is fully synchronous field
/// assignment) — a `noSuchMethod` fallback avoids hand-writing every method
/// of a large interface purely to satisfy the constructor's static types.
final class _NoopDriverOfflineCacheRepository
    implements DriverOfflineCacheRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _NoopDriverSyncQueueRepository
    implements DriverSyncQueueRepository {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
