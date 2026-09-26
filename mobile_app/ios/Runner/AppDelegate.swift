import Firebase
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Prompt 15 (Push Notifications): requires a real
    // `ios/Runner/GoogleService-Info.plist` to actually succeed — that file
    // does not exist yet (see `lib/firebase_options.dart`), so this will
    // fail/log at runtime until a real Firebase iOS app is registered. Not
    // buildable/runnable from this Windows machine (no Xcode) — foundation
    // only, not verified end-to-end.
    FirebaseApp.configure()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }
}
