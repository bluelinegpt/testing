import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

final class RoleDashboardPage extends ConsumerWidget {
  const RoleDashboardPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authenticationProvider).value?.user;
    final l10n = AppLocalizations.of(context);
    if (user == null) return AppErrorState(message: l10n.sessionExpired);
    final cards = _cardsFor(context, user, l10n);
    return RefreshIndicator(
      onRefresh: () async {},
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Text(
            '${l10n.welcome}, ${user.displayName}',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(_roleLabel(user, l10n)),
          const SizedBox(height: AppSpacing.lg),
          if (user.hasRole(UserRole.trader) && user.can('orders.create')) ...[
            FilledButton.icon(
              onPressed: () => context.go('/create-order'),
              icon: const Icon(Icons.add),
              label: Text(l10n.createOrder),
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          ResponsiveSummaryGrid(children: cards),
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
      ),
    );
  }

  List<Widget> _cardsFor(
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
    } else if (user.hasRole(UserRole.operatorRole)) {
      definitions = [
        (l10n.newStatus, Icons.fiber_new_outlined, '/orders'),
        (l10n.unassignedOrders, Icons.assignment_late_outlined, '/orders'),
        (l10n.assignedOrders, Icons.assignment_ind_outlined, '/orders'),
        (l10n.outForDelivery, Icons.local_shipping_outlined, '/orders'),
        (l10n.deliveryFailures, Icons.report_problem_outlined, '/orders'),
        (l10n.returnRequired, Icons.keyboard_return, '/orders'),
        (l10n.itemsRequiringAttention, Icons.priority_high, null),
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

String _roleLabel(AuthenticatedUser user, AppLocalizations l10n) {
  if (user.hasRole(UserRole.trader)) return l10n.trader;
  if (user.hasRole(UserRole.driver)) return l10n.driver;
  if (user.hasRole(UserRole.operatorRole)) return l10n.operator;
  if (user.hasRole(UserRole.customer)) return l10n.customer;
  return l10n.unsupportedRole;
}
