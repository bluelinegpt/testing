import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/routing/app_router.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/features/common/pages.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final class BluelineApp extends ConsumerWidget {
  const BluelineApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final startup = ref.watch(startupProvider);
    final locale = ref.watch(localeProvider).value ?? const Locale('en');
    return startup.when(
      data: (_) => const _RoutedApp(),
      loading: () => _LocalizedFrame(locale: locale, home: const StartupPage()),
      error: (_, _) =>
          _LocalizedFrame(locale: locale, home: const StartupFailurePage()),
    );
  }
}

final class _RoutedApp extends ConsumerWidget {
  const _RoutedApp();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final locale = ref.watch(localeProvider).value ?? const Locale('en');
    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      title: 'BluelineGPT',
      theme: buildAppTheme(),
      locale: locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      routerConfig: ref.watch(routerProvider),
    );
  }
}

final class _LocalizedFrame extends StatelessWidget {
  const _LocalizedFrame({required this.locale, required this.home});
  final Locale locale;
  final Widget home;
  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildAppTheme(),
    locale: locale,
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: const [
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: home,
  );
}
