import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/routing/app_router.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/features/common/pages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('English and Arabic localization load', () async {
    final english = await AppLocalizations.delegate.load(const Locale('en'));
    final arabic = await AppLocalizations.delegate.load(const Locale('ar'));
    expect(english.login, 'Log in');
    expect(arabic.login, 'تسجيل الدخول');
  });

  testWidgets('Arabic applies RTL direction', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        locale: Locale('ar'),
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: Scaffold(body: Text('اختبار')),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      Directionality.of(tester.element(find.text('اختبار'))),
      TextDirection.rtl,
    );
  });

  test('role navigation changes by backend role', () async {
    final l10n = await AppLocalizations.delegate.load(const Locale('en'));
    final trader = _user({UserRole.trader}, {'orders.create'});
    final driver = _user({UserRole.driver}, const {});
    expect(
      navigationFor(trader, l10n).map((item) => item.path),
      contains('/create-order'),
    );
    expect(
      navigationFor(driver, l10n).map((item) => item.path),
      isNot(contains('/create-order')),
    );
  });

  test('Operator and Customer navigation remain role safe', () async {
    final l10n = await AppLocalizations.delegate.load(const Locale('en'));
    final operator = navigationFor(
      _user({UserRole.operatorRole}, {'orders.view'}),
      l10n,
    );
    final customer = navigationFor(_user({UserRole.customer}, const {}), l10n);
    expect(operator.map((item) => item.path), isNot(contains('/create-order')));
    expect(customer.map((item) => item.path), isNot(contains('/dashboard')));
    expect(customer.map((item) => item.path), isNot(contains('/create-order')));
  });

  test('restricted routes are blocked even when entered directly', () {
    final withoutPermission = AuthenticationState(
      AuthenticationStatus.authenticated,
      session: _session(_user({UserRole.trader}, const {})),
    );
    final withPermission = AuthenticationState(
      AuthenticationStatus.authenticated,
      session: _session(_user({UserRole.trader}, {'orders.create'})),
    );
    expect(redirectFor(withoutPermission, '/create-order'), '/unauthorized');
    expect(redirectFor(withPermission, '/create-order'), isNull);
    expect(
      redirectFor(const AuthenticationState.unauthenticated(), '/orders'),
      '/login?from=%2Forders',
    );
  });
}

AuthenticatedUser _user(Set<UserRole> roles, Set<String> permissions) =>
    AuthenticatedUser(
      id: 'user-id',
      companyId: 'company-id',
      displayName: 'Test User',
      roles: roles,
      permissions: permissions,
      accessState: AccountAccessState.active,
    );

AuthenticatedSession _session(AuthenticatedUser user) => AuthenticatedSession(
  user: user,
  expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
);
