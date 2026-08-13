# BluelineGPT Mobile

One Flutter application for Android and iOS. Backend identity, Company scope,
roles, permissions, financial rules, and workflow transitions remain the source
of truth. Prompt 1 delivers shared foundations and honest placeholders only.

## Toolchain

- Flutter 3.44.8
- Dart 3.12.2
- Riverpod for state, dependency injection, and asynchronous state
- GoRouter for centralized guarded routing
- Dio for the API transport
- Flutter secure storage for sensitive device values
- Firebase Core and Messaging behind a mockable notification interface

## Structure

```text
lib/
  app/       bootstrap, configuration, localization, providers, routing, theme
  core/      API, authentication, services, storage, validation
  features/  role-aware shell and honest feature placeholders
  shared/    reusable accessible form components
```

Riverpod providers own application-wide dependencies. Features should expose
their repositories and asynchronous state through feature-local providers.
Represent asynchronous UI with explicit loading, data/empty, offline, and error
states; do not throw transport errors into widgets.

## Environments

Configuration uses compile-time Dart definitions and contains no secrets.

```powershell
flutter run --flavor dev --dart-define-from-file=config/development.json
flutter run --flavor staging --dart-define-from-file=config/staging.example.json
flutter run --flavor prod --dart-define-from-file=config/production.example.json
```

### Build version (crash reports)

Every crash this app reports (see `lib/core/reliability/crash_reporter.dart`)
is tagged with the exact commit it was built from, the same way every other
BluelineGPT app's version badge works — so a crash on the Platform's Error
Handler screen can be tied to a specific build, not just "the mobile app".
This is NOT baked in automatically the way Vite does it for the web apps;
Flutter has no equivalent build-time hook, so it must be passed explicitly:

```powershell
flutter run --flavor dev --dart-define-from-file=config/development.json --dart-define=APP_COMMIT=$(git rev-parse --short HEAD)
flutter build apk --flavor prod --dart-define-from-file=config/production.example.json --dart-define=APP_COMMIT=$(git rev-parse --short HEAD)
```

Omitting the flag is fine for a quick local debug run — it falls back to
`"dev"` rather than failing the build — but any build that will actually be
installed on a device should always include it.

### Physical Android device development

`config/development.json` is the development-only LAN configuration. It currently
targets `http://192.168.68.108:5174/api/v1`; update that host whenever the
developer machine receives a different LAN address. The dev Android flavor alone
permits cleartext HTTP for this local-network workflow. Staging and production
continue to require HTTPS/WSS and do not inherit this setting.

For an Android emulator, do not change the shared file. Override the endpoints
at launch instead, using `10.0.2.2` to reach the host machine:

```powershell
flutter run --flavor dev --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1 --dart-define=REALTIME_URL=ws://10.0.2.2:3000/api/v1/communication/realtime
```

The NestJS API development bootstrap already binds to `0.0.0.0`, so it can
accept LAN requests when the local firewall permits port 5174.

Android IDs and names:

- dev: `com.bluelinegpt.mobile.dev` / BluelineGPT Dev
- staging: `com.bluelinegpt.mobile.staging` / BluelineGPT Staging
- prod: `com.bluelinegpt.mobile` / BluelineGPT

iOS Debug, Profile, and Release are prepared as development, staging, and
production respectively. Before distribution, create named Xcode schemes for
each environment and configure signing outside source control.

## Localization and design

All current visible strings are in English and Arabic ARB files under
`lib/app/localization`. Flutter applies LTR/RTL automatically; the selected
language is stored securely. Use locale-aware `intl` formatting for future AED,
date, time, and numeric values. Keep identifiers such as phone and Order numbers
in directional isolation when displayed.

The blue theme tokens are temporary because no official brand assets were found.
Replace centralized values in `app_theme.dart`; do not scatter brand constants.

## Security and storage

Sensitive storage is reserved for access/refresh tokens, User ID, Company ID,
session metadata, locale, and device registration ID. Passwords are never stored.
Non-sensitive UI preferences may use shared preferences. Logout clears all
sensitive session/device scope while preserving the language choice.

Tokens cached on-device are never treated as proof of identity. Session restore
must call `/auth/me` before constructing an authenticated user. Logging records
event names and error types, not tokens, passwords, addresses, or financial data.

## Firebase notifications

The Firebase adapter fails safely when configuration is absent. Tests do not use
live Firebase. Add environment-appropriate files locally when supplied:

```text
android/app/google-services.json
ios/Runner/GoogleService-Info.plist
```

Then add the platform Firebase build integration using FlutterFire for each
environment. Never commit private production credentials. Backend device
registration and notification-recipient contracts are still required; see
`BACKEND_DEPENDENCIES.md`.

## Real-time and offline

`RealtimeClient` defines authenticated, Company-scoped connections and testable
reconnection. Repository ports reserve conversations, messages, and voice
metadata. No local timer pretends to provide production real-time behavior.

Offline ports reserve a User-and-Company-scoped store, pending queue,
idempotency, original timestamps, synchronization, and conflict handling. The
full encrypted local database and Driver synchronization policy belong to a
later prompt. Financial actions must not be acknowledged until the server
accepts their stable idempotency key.

## Developer checks

```powershell
flutter pub get
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
flutter build apk --debug --flavor dev --dart-define-from-file=config/development.json
```

### Android physical-device rebuild and install

The development-only helper rebuilds the dev APK, verifies exactly one authorized
ADB device, then installs it. It uses the configured Flutter SDK and local Android
SDK paths; it does not use release signing or credentials.

Each execution automatically increments a local, ignored dev build number and
passes it to Flutter. This ensures a physical device always receives a visibly
new development build without changing staging or production version behavior.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\rebuild-dev-android.ps1
```

To install and launch the development app immediately:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\rebuild-dev-android.ps1 -Launch
```

iOS builds require macOS/Xcode. Release signing keys, provisioning profiles,
Firebase files, and production endpoints are intentionally absent.
