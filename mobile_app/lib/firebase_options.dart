// ignore_for_file: type=lint
// coverage:ignore-file

/// PLACEHOLDER Firebase configuration for BluelineGPT mobile (Prompt 15 —
/// Push Notifications).
///
/// No real Firebase project has been created for this app yet. Every value
/// below is an obviously-fake placeholder so `Firebase.initializeApp()`
/// fails safely (handled by `SafeFirebaseNotificationService`'s try/catch —
/// see `lib/core/services/service_ports.dart`) instead of ever being
/// mistaken for a working configuration.
///
/// This file is safe to commit: Firebase *client* configuration (API key,
/// App ID, Sender ID, Project ID) is not a secret — it identifies the
/// project to Google's client SDKs, the same way it appears inside every
/// shipped app binary. It is fundamentally different from the server-side
/// `FIREBASE_SERVICE_ACCOUNT_JSON` admin credential, which must never be
/// committed and is not present anywhere in this repository.
///
/// TO ACTIVATE PUSH NOTIFICATIONS FOR REAL:
///   1. Create a Firebase project and register the Android app
///      (`com.bluelinegpt.mobile`, plus per-flavor suffixes `.dev`/`.staging`
///      if registered separately) and the iOS app
///      (`com.bluelinegpt.mobile`).
///   2. Run `flutterfire configure` from the `mobile_app/` directory, which
///      regenerates this file with real values AND drops the real
///      `android/app/google-services.json` /
///      `ios/Runner/GoogleService-Info.plist` files into place — OR hand-fill
///      the values below from the Firebase console (Project settings ▸
///      General ▸ Your apps) if `flutterfire configure` is unavailable.
///   3. Nothing else in the Dart code needs to change — Android's
///      `google-services.json`-driven Gradle plugin and this file's
///      `DefaultFirebaseOptions.currentPlatform` are the only two places a
///      real project's identity is read from.
library;

import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

/// Default [FirebaseOptions] for use with your Firebase apps.
///
/// Example:
/// ```dart
/// import 'firebase_options.dart';
/// // ...
/// await Firebase.initializeApp(
///   options: DefaultFirebaseOptions.currentPlatform,
/// );
/// ```
abstract final class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) return web;
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      default:
        throw UnsupportedError(
          'DefaultFirebaseOptions have not been configured for '
          '$defaultTargetPlatform — Prompt 15 only targets Android and iOS.',
        );
    }
  }

  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    appId: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    messagingSenderId: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    projectId: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
  );

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    appId: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    messagingSenderId: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    projectId: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    appId: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    messagingSenderId: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    projectId: 'REPLACE_WITH_REAL_FIREBASE_CONFIG',
    iosBundleId: 'com.bluelinegpt.mobile',
  );
}
