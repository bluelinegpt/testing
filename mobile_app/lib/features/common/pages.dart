import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/configuration/app_environment.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';

final class StartupPage extends StatelessWidget {
  const StartupPage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: Semantics(
        label: AppLocalizations.of(context).startup,
        child: const CircularProgressIndicator(),
      ),
    ),
  );
}

final class StartupFailurePage extends ConsumerWidget {
  const StartupFailurePage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
    body: SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 48, color: AppColors.error),
              const SizedBox(height: AppSpacing.md),
              Text(AppLocalizations.of(context).somethingWentWrong),
              const SizedBox(height: AppSpacing.md),
              FilledButton(
                onPressed: () => ref.invalidate(startupProvider),
                child: Text(AppLocalizations.of(context).retry),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

final class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({super.key});
  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

final class _LoginPageState extends ConsumerState<LoginPage> {
  final _formKey = GlobalKey<FormState>();
  final _identifier = TextEditingController();
  final _password = TextEditingController();

  @override
  void dispose() {
    _identifier.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final authentication = ref.watch(authenticationProvider);
    final failure = authentication.value?.failureCode;
    final authState = authentication.value;
    final configuration = ref.watch(configurationProvider);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.login),
        actions: [
          IconButton(
            tooltip: l10n.language,
            onPressed: () {
              final next = Localizations.localeOf(context).languageCode == 'ar'
                  ? const Locale('en')
                  : const Locale('ar');
              ref.read(localeProvider.notifier).change(next);
            },
            icon: const Icon(Icons.language),
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Form(
                key: _formKey,
                child: AutofillGroup(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Icon(
                        Icons.local_shipping_outlined,
                        size: 64,
                        color: AppColors.primary,
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      TextFormField(
                        controller: _identifier,
                        autofillHints: const [
                          AutofillHints.username,
                          AutofillHints.email,
                        ],
                        textInputAction: TextInputAction.next,
                        decoration: InputDecoration(labelText: l10n.identifier),
                        validator: (value) =>
                            value == null || value.trim().isEmpty
                            ? l10n.requiredField
                            : null,
                      ),
                      const SizedBox(height: AppSpacing.md),
                      TextFormField(
                        controller: _password,
                        autofillHints: const [AutofillHints.password],
                        obscureText: true,
                        textInputAction: TextInputAction.done,
                        decoration: InputDecoration(labelText: l10n.password),
                        validator: (value) => value == null || value.isEmpty
                            ? l10n.requiredField
                            : null,
                        onFieldSubmitted: (_) => _submit(),
                      ),
                      if (failure != null) ...[
                        const SizedBox(height: AppSpacing.md),
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            _failureMessage(l10n, failure),
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(height: AppSpacing.lg),
                      FilledButton(
                        onPressed: authentication.isLoading ? null : _submit,
                        child: authentication.isLoading
                            ? const SizedBox.square(
                                dimension: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : Text(l10n.login),
                      ),
                      TextButton(
                        onPressed: () => context.go('/forgot-password'),
                        child: Text(l10n.forgotPassword),
                      ),
                      if (configuration.environment !=
                          AppEnvironment.production) ...[
                        const SizedBox(height: AppSpacing.lg),
                        _LoginDiagnostics(
                          configuration: configuration,
                          failureCode: authState?.failureCode,
                          failureKind: authState?.failureKind,
                          failureStatus: authState?.failureStatus,
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    await ref
        .read(authenticationProvider.notifier)
        .login(
          LoginInput(identifier: _identifier.text, password: _password.text),
        );
  }

  String _failureMessage(AppLocalizations l10n, String code) => switch (code) {
    'invalid_credentials' || 'unauthorized' => l10n.invalidCredentials,
    'unsupportedRole' => l10n.unsupportedRole,
    'missingCompany' => l10n.missingCompany,
    'missingProfile' => l10n.missingProfile,
    _ => l10n.loginUnavailable,
  };
}

final class _LoginDiagnostics extends StatelessWidget {
  const _LoginDiagnostics({
    required this.configuration,
    this.failureCode,
    this.failureKind,
    this.failureStatus,
  });
  final AppConfiguration configuration;
  final String? failureCode;
  final String? failureKind;
  final int? failureStatus;

  @override
  Widget build(BuildContext context) => FutureBuilder<PackageInfo>(
    future: PackageInfo.fromPlatform(),
    builder: (context, snapshot) {
      final info = snapshot.data;
      final exposeHost =
          configuration.environment == AppEnvironment.development;
      final category = _category();
      final error = failureStatus == null
          ? category
          : 'HTTP $failureStatus — $category';
      return Text(
        [
          configuration.environment == AppEnvironment.development
              ? 'DEV'
              : 'STAGING',
          'Ver: ${info?.version ?? '…'}+${info?.buildNumber ?? '…'}',
          if (exposeHost)
            'IP: ${configuration.apiBaseUrl.host}${configuration.apiBaseUrl.hasPort ? ':${configuration.apiBaseUrl.port}' : ''}',
          'Error: $error',
        ].join('\n'),
        style: Theme.of(context).textTheme.bodySmall,
      );
    },
  );

  String _category() {
    if (failureKind == null && failureCode == null) return 'NONE';
    if (failureStatus != null) {
      return failureCode?.toUpperCase() ?? 'HTTP_$failureStatus';
    }
    return switch (failureKind) {
      'timeout' => 'CONNECTION_TIMEOUT',
      'network' => 'NETWORK_UNREACHABLE',
      'invalidResponse' => 'INVALID_RESPONSE',
      _ => 'UNKNOWN_ERROR',
    };
  }
}

final class ForgotPasswordPage extends StatelessWidget {
  const ForgotPasswordPage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(AppLocalizations.of(context).forgotPassword)),
    body: Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Text(
          AppLocalizations.of(context).forgotPasswordUnavailable,
          textAlign: TextAlign.center,
        ),
      ),
    ),
  );
}

final class ChangePasswordPage extends ConsumerStatefulWidget {
  const ChangePasswordPage({super.key});
  @override
  ConsumerState<ChangePasswordPage> createState() => _ChangePasswordPageState();
}

final class _ChangePasswordPageState extends ConsumerState<ChangePasswordPage> {
  final current = TextEditingController();
  final next = TextEditingController();
  bool loading = false;
  String? error;

  @override
  void dispose() {
    current.dispose();
    next.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.changePassword)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.lg),
          children: [
            TextFormField(
              controller: current,
              obscureText: true,
              autofillHints: const [AutofillHints.password],
              decoration: InputDecoration(labelText: l10n.currentPassword),
            ),
            const SizedBox(height: AppSpacing.md),
            TextFormField(
              controller: next,
              obscureText: true,
              autofillHints: const [AutofillHints.newPassword],
              decoration: InputDecoration(
                labelText: l10n.newPassword,
                helperText: l10n.passwordMinimum,
              ),
            ),
            if (error != null) ...[
              const SizedBox(height: AppSpacing.md),
              Text(
                error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
            const SizedBox(height: AppSpacing.lg),
            FilledButton(
              onPressed: loading ? null : _submit,
              child: loading
                  ? const SizedBox.square(
                      dimension: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(l10n.savePassword),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _submit() async {
    final l10n = AppLocalizations.of(context);
    setState(() {
      loading = true;
      error = null;
    });
    final code = await ref
        .read(authenticationProvider.notifier)
        .changePassword(current.text, next.text);
    if (!mounted) return;
    setState(() {
      loading = false;
      error = code == null
          ? null
          : (code == 'password_length'
                ? l10n.passwordMinimum
                : l10n.passwordChangeFailed);
    });
    if (code == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.passwordChanged)));
      context.pop();
    }
  }
}

final class AccountPage extends ConsumerWidget {
  const AccountPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authenticationProvider).value?.user;
    final l10n = AppLocalizations.of(context);
    if (user == null) return MessagePage(message: l10n.sessionExpired);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.lg),
      children: [
        ListTile(
          leading: const Icon(Icons.person_outline),
          title: Text(user.displayName),
          subtitle: Text(_roleLabel(user, l10n)),
        ),
        ListTile(
          leading: const Icon(Icons.language),
          title: Text(l10n.language),
          subtitle: Text(
            Localizations.localeOf(context).languageCode.toUpperCase(),
          ),
        ),
        FutureBuilder<PackageInfo>(
          future: PackageInfo.fromPlatform(),
          builder: (_, snapshot) => ListTile(
            leading: const Icon(Icons.info_outline),
            title: Text(l10n.appVersion),
            subtitle: Text(snapshot.data?.version ?? '—'),
          ),
        ),
        if (user.hasRole(UserRole.trader)) ...[
          ListTile(
            leading: const Icon(Icons.account_balance_wallet_outlined),
            title: Text(l10n.financialSummary),
            onTap: () => context.push('/trader/finance'),
          ),
          ListTile(
            leading: const Icon(Icons.payments_outlined),
            title: Text(l10n.settlements),
            onTap: () => context.push('/trader/settlements'),
          ),
          ListTile(
            leading: const Icon(Icons.receipt_long_outlined),
            title: Text(l10n.accountStatement),
            onTap: () => context.push('/trader/statement'),
          ),
        ],
        ListTile(
          leading: const Icon(Icons.password),
          title: Text(l10n.changePassword),
          onTap: () => context.push('/change-password'),
        ),
        ListTile(
          leading: const Icon(Icons.help_outline),
          title: Text(l10n.helpSupport),
          subtitle: Text(l10n.notImplemented),
        ),
        ListTile(
          leading: const Icon(Icons.privacy_tip_outlined),
          title: Text(l10n.privacyPolicy),
          subtitle: Text(l10n.notImplemented),
        ),
        ListTile(
          leading: const Icon(Icons.description_outlined),
          title: Text(l10n.termsConditions),
          subtitle: Text(l10n.notImplemented),
        ),
        ListTile(
          leading: const Icon(Icons.settings_outlined),
          title: Text(l10n.settings),
          onTap: () => context.push('/settings'),
        ),
        const SizedBox(height: AppSpacing.md),
        FilledButton.tonalIcon(
          onPressed: () async {
            final confirmed = await showDialog<bool>(
              context: context,
              builder: (dialogContext) => AlertDialog(
                title: Text(l10n.logoutConfirm),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(dialogContext, false),
                    child: Text(l10n.cancel),
                  ),
                  FilledButton(
                    onPressed: () => Navigator.pop(dialogContext, true),
                    child: Text(l10n.logout),
                  ),
                ],
              ),
            );
            if (confirmed == true) {
              await ref.read(authenticationProvider.notifier).logout();
            }
          },
          icon: const Icon(Icons.logout),
          label: Text(l10n.logout),
        ),
      ],
    );
  }
}

final class SettingsPage extends ConsumerWidget {
  const SettingsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        ListTile(
          leading: const Icon(Icons.language),
          title: Text(l10n.language),
          subtitle: Text(
            Localizations.localeOf(context).languageCode.toUpperCase(),
          ),
          onTap: () {
            final next = Localizations.localeOf(context).languageCode == 'ar'
                ? const Locale('en')
                : const Locale('ar');
            ref.read(localeProvider.notifier).change(next);
          },
        ),
        ListTile(
          leading: const Icon(Icons.password),
          title: Text(l10n.changePassword),
          onTap: () => context.push('/change-password'),
        ),
        ListTile(
          leading: const Icon(Icons.privacy_tip_outlined),
          title: Text(l10n.privacyPolicy),
          subtitle: Text(l10n.notImplemented),
        ),
        ListTile(
          leading: const Icon(Icons.description_outlined),
          title: Text(l10n.termsConditions),
          subtitle: Text(l10n.notImplemented),
        ),
        ListTile(
          leading: const Icon(Icons.help_outline),
          title: Text(l10n.helpSupport),
          subtitle: Text(l10n.notImplemented),
        ),
        ListTile(
          leading: const Icon(Icons.info_outline),
          title: Text(l10n.about),
          subtitle: const Text('BluelineGPT'),
        ),
      ],
    );
  }
}

String _roleLabel(AuthenticatedUser user, AppLocalizations l10n) {
  if (user.hasRole(UserRole.trader)) return l10n.trader;
  if (user.hasRole(UserRole.driver)) return l10n.driver;
  if (user.hasRole(UserRole.operatorRole)) return l10n.operator;
  if (user.hasRole(UserRole.customer)) return l10n.customer;
  return l10n.unsupportedRole;
}

final class PlaceholderPage extends StatelessWidget {
  const PlaceholderPage({required this.title, super.key});
  final String title;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.construction_outlined, size: 48),
          const SizedBox(height: AppSpacing.md),
          Text(title, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: AppSpacing.sm),
          Text(
            AppLocalizations.of(context).notImplemented,
            textAlign: TextAlign.center,
          ),
        ],
      ),
    ),
  );
}

final class MessagePage extends StatelessWidget {
  const MessagePage({required this.message, super.key});
  final String message;
  @override
  Widget build(BuildContext context) =>
      Scaffold(body: Center(child: Text(message)));
}

@immutable
final class AppNavigationItem {
  const AppNavigationItem(this.path, this.label, this.icon);
  final String path;
  final String label;
  final IconData icon;
}

List<AppNavigationItem> navigationFor(
  AuthenticatedUser user,
  AppLocalizations l10n,
) {
  if (user.hasRole(UserRole.trader)) {
    return [
      AppNavigationItem('/dashboard', l10n.dashboard, Icons.dashboard_outlined),
      AppNavigationItem('/orders', l10n.orders, Icons.inventory_2_outlined),
      if (user.can('orders.create'))
        AppNavigationItem(
          '/create-order',
          l10n.createOrder,
          Icons.add_box_outlined,
        ),
      AppNavigationItem('/messages', l10n.messages, Icons.chat_outlined),
      AppNavigationItem('/profile', l10n.account, Icons.person_outline),
    ];
  }
  if (user.hasRole(UserRole.driver)) {
    return [
      AppNavigationItem('/dashboard', l10n.dashboard, Icons.dashboard_outlined),
      AppNavigationItem(
        '/orders',
        l10n.myOrders,
        Icons.local_shipping_outlined,
      ),
      AppNavigationItem('/messages', l10n.messages, Icons.chat_outlined),
      AppNavigationItem(
        '/notifications',
        l10n.notifications,
        Icons.notifications_outlined,
      ),
      AppNavigationItem('/profile', l10n.account, Icons.person_outline),
    ];
  }
  if (user.hasRole(UserRole.customer)) {
    return [
      AppNavigationItem('/orders', l10n.trackOrder, Icons.location_searching),
      AppNavigationItem('/messages', l10n.messages, Icons.chat_outlined),
      AppNavigationItem(
        '/notifications',
        l10n.notifications,
        Icons.notifications_outlined,
      ),
      AppNavigationItem('/profile', l10n.account, Icons.person_outline),
    ];
  }
  if (user.hasRole(UserRole.operatorRole)) {
    return [
      AppNavigationItem('/dashboard', l10n.dashboard, Icons.dashboard_outlined),
      AppNavigationItem('/orders', l10n.orders, Icons.inventory_2_outlined),
      AppNavigationItem('/messages', l10n.messages, Icons.chat_outlined),
      AppNavigationItem(
        '/notifications',
        l10n.notifications,
        Icons.notifications_outlined,
      ),
      AppNavigationItem('/profile', l10n.account, Icons.person_outline),
    ];
  }
  return const [];
}

final class RoleAwareShell extends ConsumerWidget {
  const RoleAwareShell({
    required this.child,
    required this.location,
    super.key,
  });
  final Widget child;
  final String location;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authenticationProvider).value?.user;
    if (user == null) return child;
    final items = navigationFor(user, AppLocalizations.of(context));
    if (items.isEmpty) {
      return MessagePage(message: AppLocalizations.of(context).unsupportedRole);
    }
    final currentIndex = items.indexWhere(
      (item) => location.startsWith(item.path),
    );
    return Scaffold(
      appBar: AppBar(
        title: Text(_pageTitle(location, AppLocalizations.of(context))),
        actions: [
          IconButton(
            tooltip: AppLocalizations.of(context).notifications,
            onPressed: () => context.go('/notifications'),
            icon: const UnreadBadgeIcon(icon: Icons.notifications_outlined),
          ),
          IconButton(
            tooltip: AppLocalizations.of(context).language,
            onPressed: () {
              final next = Localizations.localeOf(context).languageCode == 'ar'
                  ? const Locale('en')
                  : const Locale('ar');
              ref.read(localeProvider.notifier).change(next);
            },
            icon: const Icon(Icons.language),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (ref.watch(offlineProvider).value == true)
              Semantics(
                liveRegion: true,
                child: Container(
                  width: double.infinity,
                  color: AppColors.warning,
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.md,
                    vertical: AppSpacing.sm,
                  ),
                  child: Text(
                    AppLocalizations.of(context).offlineData,
                    style: const TextStyle(color: Colors.white),
                  ),
                ),
              ),
            Expanded(child: child),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: currentIndex < 0 ? 0 : currentIndex,
        onDestinationSelected: (index) => context.go(items[index].path),
        destinations: [
          for (final item in items)
            NavigationDestination(icon: Icon(item.icon), label: item.label),
        ],
      ),
    );
  }
}

String _pageTitle(String location, AppLocalizations l10n) {
  if (location.startsWith('/orders')) return l10n.orders;
  if (location.startsWith('/messages')) return l10n.messages;
  if (location.startsWith('/notifications')) return l10n.notifications;
  if (location.startsWith('/profile')) return l10n.profile;
  if (location.startsWith('/settings')) return l10n.settings;
  return l10n.dashboard;
}
