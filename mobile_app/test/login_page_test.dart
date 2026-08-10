import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/features/common/pages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// `AuthenticationController.build()` calls `restore()` the moment
/// `authenticationProvider` is first read, so `LoginPage` (which watches it
/// for its own loading/failure state) needs a working fake underneath —
/// exactly the same seam `operator_dashboard_and_detail_test.dart` uses,
/// since `AuthenticationController` itself is `final` and can't be faked
/// directly from a test file.
final class _FakeAuthenticationService implements AuthenticationService {
  int loginCalls = 0;
  LoginInput? lastLogin;

  @override
  Future<AuthenticationState> restore() async =>
      const AuthenticationState.unauthenticated();
  @override
  Future<AuthenticationState> login(LoginInput input) async {
    loginCalls += 1;
    lastLogin = input;
    return const AuthenticationState.unauthenticated();
  }

  @override
  Future<void> logout() async {}
  @override
  Future<String?> changePassword(
    String currentPassword,
    String newPassword,
  ) async => null;
}

Widget _wrap(AuthenticationService service) => ProviderScope(
  overrides: [authenticationServiceProvider.overrideWithValue(service)],
  child: const MaterialApp(
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: [
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: LoginPage(),
  ),
);

// `TextFormField` doesn't expose `obscureText` itself (it's forwarded
// internally to the `TextField`/`EditableText` it builds), so assertions
// read it off the underlying `EditableText`.
bool _passwordObscured(WidgetTester tester) => tester
    .widget<EditableText>(
      find.descendant(
        of: find.byKey(const Key('loginPasswordField')),
        matching: find.byType(EditableText),
      ),
    )
    .obscureText;

String _passwordText(WidgetTester tester) => tester
    .widget<EditableText>(
      find.descendant(
        of: find.byKey(const Key('loginPasswordField')),
        matching: find.byType(EditableText),
      ),
    )
    .controller
    .text;

void main() {
  group('LoginPage password visibility (mobile Login enhancement)', () {
    testWidgets('password is masked by default', (tester) async {
      await tester.pumpWidget(_wrap(_FakeAuthenticationService()));
      await tester.pumpAndSettle();

      expect(_passwordObscured(tester), isTrue);
      expect(find.byIcon(Icons.visibility), findsOneWidget);
      expect(find.byIcon(Icons.visibility_off), findsNothing);
    });

    testWidgets('tapping the eye icon reveals the password', (tester) async {
      await tester.pumpWidget(_wrap(_FakeAuthenticationService()));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('loginPasswordVisibilityToggle')));
      await tester.pumpAndSettle();

      expect(_passwordObscured(tester), isFalse);
      expect(find.byIcon(Icons.visibility_off), findsOneWidget);
      expect(find.byIcon(Icons.visibility), findsNothing);
    });

    testWidgets('tapping the eye icon again re-masks the password', (
      tester,
    ) async {
      await tester.pumpWidget(_wrap(_FakeAuthenticationService()));
      await tester.pumpAndSettle();

      final toggle = find.byKey(const Key('loginPasswordVisibilityToggle'));
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      await tester.tap(toggle);
      await tester.pumpAndSettle();

      expect(_passwordObscured(tester), isTrue);
      expect(find.byIcon(Icons.visibility), findsOneWidget);
    });

    testWidgets('toggling visibility never changes the typed password', (
      tester,
    ) async {
      final service = _FakeAuthenticationService();
      await tester.pumpWidget(_wrap(service));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('loginPasswordField')),
        's3cret-Pass!',
      );
      await tester.pumpAndSettle();
      expect(_passwordText(tester), 's3cret-Pass!');

      final toggle = find.byKey(const Key('loginPasswordVisibilityToggle'));
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(_passwordText(tester), 's3cret-Pass!');

      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(_passwordText(tester), 's3cret-Pass!');

      // The value that actually reaches the auth service is unaffected too.
      await tester.enterText(
        find.byKey(const Key('loginIdentifierField')),
        'driver@example.com',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Log in'));
      await tester.pumpAndSettle();
      expect(service.lastLogin?.password, 's3cret-Pass!');
    });

    testWidgets('the toggle exposes an accessible show/hide tooltip', (
      tester,
    ) async {
      await tester.pumpWidget(_wrap(_FakeAuthenticationService()));
      await tester.pumpAndSettle();

      expect(find.byTooltip('Show password'), findsOneWidget);
      await tester.tap(find.byKey(const Key('loginPasswordVisibilityToggle')));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Hide password'), findsOneWidget);
    });
  });
}
