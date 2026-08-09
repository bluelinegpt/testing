import 'dart:async';

import 'package:bluelinegpt_mobile/app/app.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

Future<void> bootstrap() async {
  await runZonedGuarded(
    () async {
      WidgetsFlutterBinding.ensureInitialized();
      FlutterError.onError = (details) {
        FlutterError.presentError(details);
        Zone.current.handleUncaughtError(
          details.exception,
          details.stack ?? StackTrace.current,
        );
      };
      PlatformDispatcher.instance.onError = (error, stack) {
        debugPrint('Uncaught platform error: ${error.runtimeType}');
        return true;
      };
      runApp(const ProviderScope(child: BluelineApp()));
    },
    (error, stack) =>
        debugPrint('Uncaught application error: ${error.runtimeType}'),
  );
}
