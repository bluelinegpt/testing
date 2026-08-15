import 'dart:async';

import 'package:bluelinegpt_mobile/app/app.dart';
import 'package:bluelinegpt_mobile/core/reliability/crash_reporter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

Future<void> bootstrap() async {
  await runZonedGuarded(
    () async {
      WidgetsFlutterBinding.ensureInitialized();
      FlutterError.onError = (details) {
        FlutterError.presentError(details);
        unawaited(
          reportCrash(details.exception, details.stack ?? StackTrace.current),
        );
        Zone.current.handleUncaughtError(
          details.exception,
          details.stack ?? StackTrace.current,
        );
      };
      PlatformDispatcher.instance.onError = (error, stack) {
        debugPrint('Uncaught platform error: ${error.runtimeType}');
        unawaited(reportCrash(error, stack));
        return true;
      };
      runApp(const ProviderScope(child: BluelineApp()));
    },
    (error, stack) {
      debugPrint('Uncaught application error: ${error.runtimeType}');
      unawaited(reportCrash(error, stack));
    },
  );
}
