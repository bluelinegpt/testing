import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/features/common/pages.dart';
import 'package:bluelinegpt_mobile/features/dashboard/dashboard_page.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_pages.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_pages.dart';
import 'package:bluelinegpt_mobile/features/customer/customer_pages.dart';
import 'package:bluelinegpt_mobile/features/communication/communication_pages.dart';
import 'package:bluelinegpt_mobile/features/notifications/notifications_page.dart';
import 'package:bluelinegpt_mobile/features/reliability/sync_issues_page.dart';
import 'package:bluelinegpt_mobile/features/trader/trader_pages.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final auth = ref.watch(authenticationProvider).value;
  return GoRouter(
    initialLocation: '/dashboard',
    redirect: (context, state) {
      return redirectFor(
        auth,
        state.matchedLocation,
        intended: state.uri.queryParameters['from'],
      );
    },
    errorBuilder: (context, state) =>
        MessagePage(message: AppLocalizations.of(context).notFound),
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginPage()),
      GoRoute(
        path: '/forgot-password',
        builder: (_, _) => const ForgotPasswordPage(),
      ),
      GoRoute(
        path: '/track/:token',
        builder: (_, state) =>
            CustomerTrackingPage(token: state.pathParameters['token'] ?? ''),
      ),
      GoRoute(
        path: '/change-password',
        builder: (_, _) => const ChangePasswordPage(),
      ),
      GoRoute(
        path: '/unauthorized',
        builder: (context, _) =>
            MessagePage(message: AppLocalizations.of(context).accessDenied),
      ),
      GoRoute(
        path: '/offline',
        builder: (context, _) =>
            MessagePage(message: AppLocalizations.of(context).offline),
      ),
      ShellRoute(
        builder: (_, state, child) =>
            RoleAwareShell(location: state.uri.path, child: child),
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
          GoRoute(
            path: '/orders/:id',
            builder: (_, state) {
              final orderId = state.pathParameters['id'] ?? '';
              final user = auth?.user;
              // A genuine `driver`-kind identity always uses the
              // driver-portal endpoints. A Driver User (`company_user` with
              // a resolved `linkedDriverId`) gets the identical Driver
              // presentation but must keep calling the Operator endpoints —
              // `/portal/driver/*` would 403 for a `company_user`
              // (`isDriverPresentation` covers both; `hasRole(driver)`
              // alone would wrongly route a Driver User here).
              if (user?.hasRole(UserRole.driver) == true) {
                return DriverOrderDetailsPage(orderId: orderId);
              }
              if (user?.hasRole(UserRole.operatorRole) == true &&
                  hasOperatorOrderAccess(user!.permissions)) {
                return OperatorOrderDetailsPage(
                  orderId: orderId,
                  driverPresentation: user.isDriverPresentation,
                );
              }
              return TraderOrderDetailsPage(orderId: orderId);
            },
          ),
          GoRoute(
            path: '/create-order',
            builder: (_, _) => const CreateTraderOrderPage(),
          ),
          GoRoute(
            path: '/create-order/review',
            builder: (_, _) => const TraderOrderReviewPage(),
          ),
          GoRoute(
            path: '/trader/finance',
            builder: (_, _) => const TraderFinancePage(title: 'finance'),
          ),
          GoRoute(
            path: '/trader/settlements',
            builder: (_, _) => const TraderFinancePage(title: 'settlements'),
          ),
          GoRoute(
            path: '/trader/statement',
            builder: (_, _) => const TraderFinancePage(title: 'statement'),
          ),
          GoRoute(
            path: '/messages',
            builder: (_, _) => const CommunicationInboxPage(),
          ),
          GoRoute(
            path: '/messages/:id',
            builder: (_, state) => ConversationPage(
              conversationId: state.pathParameters['id'] ?? '',
            ),
          ),
          GoRoute(
            path: '/notifications',
            builder: (_, _) => const NotificationsPage(),
          ),
          GoRoute(
            path: '/sync-issues',
            builder: (_, _) => const SyncIssuesPage(),
          ),
          GoRoute(path: '/profile', builder: (_, _) => const AccountPage()),
          GoRoute(path: '/settings', builder: (_, _) => const SettingsPage()),
          _placeholder('/trader', (l) => l.dashboard),
          _placeholder('/driver', (l) => l.dashboard),
          _placeholder('/operator', (l) => l.dashboard),
          _placeholder('/customer', (l) => l.dashboard),
        ],
      ),
    ],
  );
});

final requiredRoutePermissions = <String, String>{
  '/create-order': 'orders.create',
  '/trader': 'mobile.trader.access',
  '/driver': 'mobile.driver.access',
  '/operator': 'mobile.operator.access',
  '/customer': 'mobile.customer.access',
};

String? redirectFor(
  AuthenticationState? auth,
  String location, {
  String? intended,
}) {
  final publicRoute =
      location == '/login' ||
      location == '/forgot-password' ||
      location.startsWith('/track/');
  if (auth == null || !auth.isAuthenticated) {
    return publicRoute ? null : '/login?from=${Uri.encodeComponent(location)}';
  }
  if (auth.user!.forcePasswordChange && location != '/change-password') {
    return '/change-password';
  }
  if (location == '/login' &&
      intended != null &&
      isSafeIntendedRoute(intended)) {
    final permission = requiredRoutePermissions[intended];
    return permission == null || auth.user!.can(permission)
        ? intended
        : '/unauthorized';
  }
  if (location == '/login' || location == '/forgot-password') {
    return '/dashboard';
  }
  final permission = requiredRoutePermissions[location];
  if (permission != null && !auth.user!.can(permission)) {
    return '/unauthorized';
  }
  return null;
}

bool isSafeIntendedRoute(String route) =>
    route.startsWith('/') &&
    !route.startsWith('//') &&
    !route.contains('://') &&
    route.length <= 300;

GoRoute _placeholder(String path, String Function(AppLocalizations) title) =>
    GoRoute(
      path: path,
      builder: (context, _) =>
          PlaceholderPage(title: title(AppLocalizations.of(context))),
    );
