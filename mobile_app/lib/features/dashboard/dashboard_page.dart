import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/configuration/app_environment.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_repository.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

final class RoleDashboardPage extends ConsumerStatefulWidget {
  const RoleDashboardPage({super.key});
  @override
  ConsumerState<RoleDashboardPage> createState() => _RoleDashboardPageState();
}

final class _RoleDashboardPageState extends ConsumerState<RoleDashboardPage> {
  OperatorDashboardSummary? summary;
  DateTime? summaryLoadedAt;
  bool loading = false;
  Object? error;
  bool _requestedOperatorSummary = false;

  DriverDashboardSummary? driverSummary;
  DateTime? driverSummaryLoadedAt;
  bool driverLoading = false;
  Object? driverError;
  bool _requestedDriverSummary = false;
  DriverDataFreshness driverFreshness = const DriverDataFreshness(
    isOffline: false,
  );

  Future<void> _loadOperatorSummary() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final result = await ref
          .read(operatorRepositoryProvider)
          .dashboardSummary();
      if (!mounted) return;
      setState(() {
        summary = result;
        summaryLoadedAt = DateTime.now();
        loading = false;
      });
    } on Object catch (value) {
      if (mounted) {
        setState(() {
          error = value;
          loading = false;
        });
      }
    }
  }

  Future<void> _loadDriverSummary() async {
    setState(() {
      driverLoading = true;
      driverError = null;
    });
    try {
      final repo = ref.read(driverRepositoryProvider);
      final result = await repo.dashboardSummary();
      final freshness = repo is OfflineAwareDriverRepository
          ? await repo.dashboardFreshness()
          : const DriverDataFreshness(isOffline: false);
      if (!mounted) return;
      setState(() {
        driverSummary = result;
        driverSummaryLoadedAt = DateTime.now();
        driverFreshness = freshness;
        driverLoading = false;
      });
    } on Object catch (value) {
      if (mounted) {
        setState(() {
          driverError = value;
          driverLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = ref.watch(authenticationProvider).value?.user;
    final l10n = AppLocalizations.of(context);
    if (user == null) return AppErrorState(message: l10n.sessionExpired);
    // Data-source decision — stays on the raw `kind`/`role`, never on
    // presentation. A genuine `driver`-kind account always uses the Driver
    // repository/endpoint; a `company_user` (plain Operator OR Driver User)
    // always uses the Operator repository/endpoint, since `/portal/driver/*`
    // would 403 for a `company_user`.
    final isOperatorKind = user.hasRole(UserRole.operatorRole);
    final isGenuineDriver = user.hasRole(UserRole.driver);
    // Presentation decision — a Driver User (`company_user` +
    // `linkedDriverId` resolved) renders the Driver-style 5-card dashboard,
    // built from the same (server-narrowed) Operator summary a plain
    // Operator's dashboard already loads. `isOperator` below still governs
    // the plain-Operator 6-card layout only.
    final isDriverUser = isOperatorKind && user.isDriverPresentation;
    final isOperator = isOperatorKind && !isDriverUser;
    if (isOperatorKind && !_requestedOperatorSummary) {
      _requestedOperatorSummary = true;
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _loadOperatorSummary(),
      );
    }
    if (isGenuineDriver && !_requestedDriverSummary) {
      _requestedDriverSummary = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadDriverSummary());
    }
    return RefreshIndicator(
      onRefresh: isOperatorKind
          ? _loadOperatorSummary
          : isGenuineDriver
          ? _loadDriverSummary
          : () async {},
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Text(
            '${l10n.welcome}, ${user.displayName}',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(roleLabel(user, l10n)),
          const SizedBox(height: AppSpacing.lg),
          if (user.hasRole(UserRole.trader) && user.can('orders.create')) ...[
            FilledButton.icon(
              onPressed: () => context.go('/create-order'),
              icon: const Icon(Icons.add),
              label: Text(l10n.createOrder),
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          if (isDriverUser)
            ..._driverPresentationFromOperatorSection(context, l10n)
          else if (isOperator)
            ..._operatorSection(context, l10n)
          else if (isGenuineDriver)
            ..._driverSection(context, l10n)
          else ...[
            ResponsiveSummaryGrid(
              children: _staticCardsFor(context, user, l10n),
            ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              l10n.recentActivity,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: AppSpacing.sm),
            AppEmptyState(message: l10n.noDashboardData),
            const SizedBox(height: AppSpacing.md),
            Text(
              '${l10n.lastUpdated}: ${l10n.notAvailable}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ],
      ),
    );
  }

  List<Widget> _operatorSection(BuildContext context, AppLocalizations l10n) {
    final configuration = ref.watch(configurationProvider);
    if (error != null) {
      return [
        AppErrorState(
          message: l10n.dataUnavailable,
          onRetry: _loadOperatorSummary,
        ),
        if (configuration.environment == AppEnvironment.development)
          Text(
            devApiFailureText('Dashboard', error!),
            style: Theme.of(context).textTheme.bodySmall,
          ),
      ];
    }
    if (loading && summary == null) {
      return const [DashboardSkeleton()];
    }
    final data = summary;
    if (data == null) return const [DashboardSkeleton()];
    final allZero =
        data.activeTotal == 0 &&
        data.deliveredToday == 0 &&
        data.returnPending == 0;
    // Icons are a display-only concern kept out of `operatorDashboardCards`,
    // which is the part the permanent test suite exercises directly — one
    // icon per card, in the same fixed order.
    const icons = [
      Icons.local_shipping_outlined,
      Icons.fiber_new_outlined,
      Icons.assignment_ind_outlined,
      Icons.two_wheeler_outlined,
      Icons.check_circle_outline,
      Icons.keyboard_return,
    ];
    final cards = operatorDashboardCards(data, l10n);
    return [
      ResponsiveSummaryGrid(
        children: [
          for (final (index, card) in cards.indexed)
            SummaryCard(
              title: card.title,
              icon: icons[index],
              value: card.value,
              loading: loading,
              onTap: () => context.push(card.route),
            ),
        ],
      ),
      if (allZero) ...[
        const SizedBox(height: AppSpacing.md),
        AppEmptyState(message: l10n.noOrders),
      ],
      const SizedBox(height: AppSpacing.lg),
      Text(
        '${l10n.lastUpdated}: ${summaryLoadedAt == null ? l10n.notAvailable : _formatTime(summaryLoadedAt!)}',
        style: Theme.of(context).textTheme.bodySmall,
      ),
    ];
  }

  List<Widget> _driverSection(BuildContext context, AppLocalizations l10n) {
    final configuration = ref.watch(configurationProvider);
    if (driverError != null) {
      return [
        AppErrorState(
          message: l10n.dataUnavailable,
          onRetry: _loadDriverSummary,
        ),
        if (configuration.environment == AppEnvironment.development)
          Text(
            devApiFailureText('Dashboard', driverError!),
            style: Theme.of(context).textTheme.bodySmall,
          ),
      ];
    }
    if (driverLoading && driverSummary == null) {
      return const [DashboardSkeleton()];
    }
    final data = driverSummary;
    if (data == null) return const [DashboardSkeleton()];
    final allZero =
        data.activeTotal == 0 &&
        data.assignedToMe == 0 &&
        data.outForDelivery == 0 &&
        data.deliveredToday == 0 &&
        data.returnPending == 0;
    // Icons are a display-only concern kept out of `driverDashboardCards`,
    // which is the part the permanent test suite exercises directly — one
    // icon per card, in the same fixed order.
    const icons = [
      Icons.local_shipping_outlined,
      Icons.assignment_ind_outlined,
      Icons.two_wheeler_outlined,
      Icons.check_circle_outline,
      Icons.keyboard_return,
    ];
    final cards = driverDashboardCards(data, l10n);
    return [
      if (driverFreshness.isOffline) ...[
        Row(
          children: [
            const Icon(
              Icons.cloud_off_outlined,
              size: 16,
              color: AppColors.warning,
            ),
            const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: Text(
                '${l10n.driverOfflineBanner} — ${l10n.driverLastSyncedLabel}: '
                '${driverFreshness.lastSyncedAt == null ? l10n.notAvailable : _formatTime(driverFreshness.lastSyncedAt!)}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
      ],
      ResponsiveSummaryGrid(
        children: [
          for (final (index, card) in cards.indexed)
            SummaryCard(
              title: card.title,
              icon: icons[index],
              value: card.value,
              loading: driverLoading,
              onTap: () => context.push(card.route),
            ),
        ],
      ),
      if (allZero) ...[
        const SizedBox(height: AppSpacing.md),
        AppEmptyState(message: l10n.noOrders),
      ],
      const SizedBox(height: AppSpacing.lg),
      Text(
        '${l10n.lastUpdated}: ${driverSummaryLoadedAt == null ? l10n.notAvailable : _formatTime(driverSummaryLoadedAt!)}',
        style: Theme.of(context).textTheme.bodySmall,
      ),
    ];
  }

  /// The Driver-style 5-card dashboard for a Driver User — sourced from the
  /// same `operatorRepositoryProvider`/`_loadOperatorSummary()` state a
  /// plain Operator's dashboard already uses (never
  /// `driverRepositoryProvider`, which a `company_user` cannot call), but
  /// rendered with the Driver's card mapping (`driverDashboardCards`) via
  /// `driverPresentationSummaryFromOperator` — one card-mapping
  /// implementation, reused, not reinvented. The server has already
  /// narrowed `summary` to this Driver User's own Orders
  /// (`operatorDashboardSummary()`), so this never itself recomputes or
  /// leaks a company-wide total — it only ever reads `summary` as given.
  List<Widget> _driverPresentationFromOperatorSection(
    BuildContext context,
    AppLocalizations l10n,
  ) {
    final configuration = ref.watch(configurationProvider);
    if (error != null) {
      return [
        AppErrorState(
          message: l10n.dataUnavailable,
          onRetry: _loadOperatorSummary,
        ),
        if (configuration.environment == AppEnvironment.development)
          Text(
            devApiFailureText('Dashboard', error!),
            style: Theme.of(context).textTheme.bodySmall,
          ),
      ];
    }
    if (loading && summary == null) {
      return const [DashboardSkeleton()];
    }
    final data = summary;
    if (data == null) return const [DashboardSkeleton()];
    final driverStyleData = driverPresentationSummaryFromOperator(data);
    final allZero =
        driverStyleData.activeTotal == 0 &&
        driverStyleData.assignedToMe == 0 &&
        driverStyleData.outForDelivery == 0 &&
        driverStyleData.deliveredToday == 0 &&
        driverStyleData.returnPending == 0;
    const icons = [
      Icons.local_shipping_outlined,
      Icons.assignment_ind_outlined,
      Icons.two_wheeler_outlined,
      Icons.check_circle_outline,
      Icons.keyboard_return,
    ];
    final cards = driverDashboardCards(driverStyleData, l10n);
    return [
      ResponsiveSummaryGrid(
        children: [
          for (final (index, card) in cards.indexed)
            SummaryCard(
              title: card.title,
              icon: icons[index],
              value: card.value,
              loading: loading,
              onTap: () => context.push(card.route),
            ),
        ],
      ),
      if (allZero) ...[
        const SizedBox(height: AppSpacing.md),
        AppEmptyState(message: l10n.noOrders),
      ],
      const SizedBox(height: AppSpacing.lg),
      Text(
        '${l10n.lastUpdated}: ${summaryLoadedAt == null ? l10n.notAvailable : _formatTime(summaryLoadedAt!)}',
        style: Theme.of(context).textTheme.bodySmall,
      ),
    ];
  }

  List<Widget> _staticCardsFor(
    BuildContext context,
    AuthenticatedUser user,
    AppLocalizations l10n,
  ) {
    List<(String, IconData, String?)> definitions;
    if (user.hasRole(UserRole.trader)) {
      definitions = [
        (l10n.ordersToday, Icons.today_outlined, '/orders'),
        (l10n.newStatus, Icons.fiber_new_outlined, '/orders'),
        (l10n.assignedToDriver, Icons.assignment_ind_outlined, '/orders'),
        (l10n.outForDelivery, Icons.local_shipping_outlined, '/orders'),
        (l10n.delivered, Icons.check_circle_outline, '/orders'),
        (l10n.returnedToBranch, Icons.keyboard_return, '/orders'),
        (l10n.returnedToTrader, Icons.undo, '/orders'),
        (l10n.cancelled, Icons.cancel_outlined, '/orders'),
        (l10n.deliveredCod, Icons.payments_outlined, null),
        (l10n.netPayable, Icons.account_balance_wallet_outlined, null),
      ];
    } else if (user.hasRole(UserRole.driver)) {
      definitions = [
        (l10n.assignedOrders, Icons.assignment_outlined, '/orders'),
        (l10n.outForDelivery, Icons.local_shipping_outlined, '/orders'),
        (l10n.deliveredToday, Icons.check_circle_outline, '/orders'),
        (l10n.unsuccessfulToday, Icons.report_problem_outlined, '/orders'),
        (l10n.returnRequired, Icons.keyboard_return, '/orders'),
        (l10n.codCollectedToday, Icons.payments_outlined, null),
        (l10n.unreadMessages, Icons.chat_outlined, '/messages'),
      ];
    } else if (user.hasRole(UserRole.customer)) {
      definitions = [
        (l10n.trackCurrentOrder, Icons.location_searching, '/orders'),
        (l10n.activeOrders, Icons.inventory_2_outlined, '/orders'),
        (l10n.recentDeliveries, Icons.history, '/orders'),
        (l10n.unreadMessages, Icons.chat_outlined, '/messages'),
      ];
    } else {
      return [];
    }
    return [
      for (final item in definitions)
        SummaryCard(
          title: item.$1,
          icon: item.$2,
          value: null,
          onTap: item.$3 == null ? null : () => context.go(item.$3!),
        ),
    ];
  }
}

String _formatTime(DateTime value) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(value.hour)}:${two(value.minute)}';
}
