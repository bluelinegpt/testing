import 'dart:async';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart' as intl;

enum OrderStatusPresentation {
  newOrder,
  assigned,
  outForDelivery,
  delivered,
  returnedToBranch,
  returnedToTrader,
  cancelled,
  unknown,
}

abstract final class OrderStatusMapper {
  static OrderStatusPresentation parse(String value) => switch (value) {
    'new' => OrderStatusPresentation.newOrder,
    'assigned' || 'assigned_to_driver' => OrderStatusPresentation.assigned,
    'out_for_delivery' => OrderStatusPresentation.outForDelivery,
    'delivered' => OrderStatusPresentation.delivered,
    'returned_to_branch' => OrderStatusPresentation.returnedToBranch,
    'returned_to_trader' => OrderStatusPresentation.returnedToTrader,
    'cancelled' => OrderStatusPresentation.cancelled,
    _ => OrderStatusPresentation.unknown,
  };

  static String label(OrderStatusPresentation status, AppLocalizations l10n) =>
      switch (status) {
        OrderStatusPresentation.newOrder => l10n.newStatus,
        OrderStatusPresentation.assigned => l10n.assignedToDriver,
        OrderStatusPresentation.outForDelivery => l10n.outForDelivery,
        OrderStatusPresentation.delivered => l10n.delivered,
        OrderStatusPresentation.returnedToBranch => l10n.returnedToBranch,
        OrderStatusPresentation.returnedToTrader => l10n.returnedToTrader,
        OrderStatusPresentation.cancelled => l10n.cancelled,
        OrderStatusPresentation.unknown => l10n.unknownStatus,
      };
}

final class StatusChip extends StatelessWidget {
  const StatusChip({required this.status, super.key});
  final String status;
  @override
  Widget build(BuildContext context) {
    final mapped = OrderStatusMapper.parse(status);
    final color = switch (mapped) {
      OrderStatusPresentation.delivered => AppColors.success,
      OrderStatusPresentation.cancelled => AppColors.error,
      OrderStatusPresentation.returnedToBranch ||
      OrderStatusPresentation.returnedToTrader => AppColors.warning,
      OrderStatusPresentation.unknown => Colors.grey,
      _ => AppColors.info,
    };
    final label = OrderStatusMapper.label(mapped, AppLocalizations.of(context));
    return Semantics(
      label: '${AppLocalizations.of(context).currentStatus}: $label',
      child: Chip(
        avatar: Icon(Icons.circle, size: 12, color: color),
        label: Text(label),
      ),
    );
  }
}

final class SummaryCard extends StatelessWidget {
  const SummaryCard({
    required this.title,
    required this.icon,
    super.key,
    this.value,
    this.kind = DashboardValueKind.count,
    this.onTap,
    this.loading = false,
  });
  final String title;
  final IconData icon;
  final num? value;
  final DashboardValueKind kind;
  final VoidCallback? onTap;
  final bool loading;
  @override
  Widget build(BuildContext context) {
    final locale = Localizations.localeOf(context).toLanguageTag();
    final formatted = value == null
        ? AppLocalizations.of(context).notAvailable
        : kind == DashboardValueKind.currency
        ? intl.NumberFormat.currency(
            locale: locale,
            symbol: 'AED ',
            decimalDigits: 2,
          ).format(value)
        : intl.NumberFormat.decimalPattern(locale).format(value);
    return Semantics(
      button: onTap != null,
      label: '$title, $formatted',
      child: Card(
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(16),
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, color: Theme.of(context).colorScheme.primary),
                const SizedBox(height: AppSpacing.sm),
                Text(title, maxLines: 2, overflow: TextOverflow.ellipsis),
                const Spacer(),
                if (loading)
                  const LinearProgressIndicator()
                else
                  Text(
                    formatted,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

final class ResponsiveSummaryGrid extends StatelessWidget {
  const ResponsiveSummaryGrid({required this.children, super.key});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (_, constraints) => GridView.count(
      crossAxisCount: constraints.maxWidth >= 700 ? 3 : 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      childAspectRatio: constraints.maxWidth < 360 ? 0.75 : 1.05,
      crossAxisSpacing: AppSpacing.sm,
      mainAxisSpacing: AppSpacing.sm,
      children: children,
    ),
  );
}

final class OrderCard extends StatelessWidget {
  const OrderCard({
    required this.order,
    required this.audience,
    super.key,
    this.onTap,
  });
  final OrderCardModel order;
  final OrderAudience audience;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final showCustomer =
        audience == OrderAudience.trader ||
        audience == OrderAudience.driver ||
        audience == OrderAudience.operatorRole;
    final showTraderMoney =
        audience == OrderAudience.trader ||
        audience == OrderAudience.operatorRole;
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Directionality(
                      textDirection: TextDirection.ltr,
                      child: Text(
                        order.orderNumber,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                  ),
                  StatusChip(status: order.status),
                ],
              ),
              if (showCustomer && order.customerName != null)
                Text('${l10n.customerName}: ${order.customerName}'),
              if (order.emirate != null || order.area != null)
                Text(
                  [order.emirate, order.area].whereType<String>().join(' • '),
                ),
              if (showCustomer && order.mobileNumber != null)
                Directionality(
                  textDirection: TextDirection.ltr,
                  child: Text(order.mobileNumber!),
                ),
              if (showCustomer && order.addressSummary != null)
                Text(order.addressSummary!),
              if (showTraderMoney && order.cod != null)
                Text('${l10n.cod}: AED ${order.cod}'),
              if (showTraderMoney && order.deliveryFee != null)
                Text('${l10n.deliveryFee}: AED ${order.deliveryFee}'),
            ],
          ),
        ),
      ),
    );
  }
}

final class AppSearchField extends StatefulWidget {
  const AppSearchField({
    required this.onChanged,
    super.key,
    this.loading = false,
    this.debounce = const Duration(milliseconds: 350),
  });
  final ValueChanged<String> onChanged;
  final bool loading;
  final Duration debounce;
  @override
  State<AppSearchField> createState() => _AppSearchFieldState();
}

final class _AppSearchFieldState extends State<AppSearchField> {
  final controller = TextEditingController();
  Timer? timer;
  @override
  void dispose() {
    timer?.cancel();
    controller.dispose();
    super.dispose();
  }

  void changed(String value) {
    timer?.cancel();
    timer = Timer(
      widget.debounce,
      () => widget.onChanged(value.substring(0, value.length.clamp(0, 200))),
    );
    setState(() {});
  }

  @override
  Widget build(BuildContext context) => TextField(
    controller: controller,
    onChanged: changed,
    decoration: InputDecoration(
      labelText: AppLocalizations.of(context).search,
      prefixIcon: const Icon(Icons.search),
      suffixIcon: widget.loading
          ? const Padding(
              padding: EdgeInsets.all(12),
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : controller.text.isEmpty
          ? null
          : IconButton(
              onPressed: () {
                controller.clear();
                changed('');
              },
              icon: const Icon(Icons.clear),
            ),
    ),
  );
}

final class AppEmptyState extends StatelessWidget {
  const AppEmptyState({
    required this.message,
    super.key,
    this.icon = Icons.inbox_outlined,
  });
  final String message;
  final IconData icon;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 48),
          const SizedBox(height: AppSpacing.sm),
          Text(message, textAlign: TextAlign.center),
        ],
      ),
    ),
  );
}

final class AppErrorState extends StatelessWidget {
  const AppErrorState({required this.message, super.key, this.onRetry});
  final String message;
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_outlined, size: 48),
            const SizedBox(height: AppSpacing.sm),
            Text(message, textAlign: TextAlign.center),
            if (onRetry != null)
              TextButton(
                onPressed: onRetry,
                child: Text(AppLocalizations.of(context).retry),
              ),
          ],
        ),
      ),
    ),
  );
}

final class UnreadBadgeIcon extends StatelessWidget {
  const UnreadBadgeIcon({required this.icon, super.key, this.count});
  final IconData icon;
  final int? count;
  @override
  Widget build(BuildContext context) => Badge(
    isLabelVisible: count != null && count! > 0,
    label: count == null ? null : Text(count! > 99 ? '99+' : '$count'),
    child: Icon(icon),
  );
}

final class DashboardSkeleton extends StatelessWidget {
  const DashboardSkeleton({super.key});
  @override
  Widget build(BuildContext context) => ResponsiveSummaryGrid(
    children: List.generate(
      4,
      (_) => SummaryCard(
        title: AppLocalizations.of(context).dataUnavailable,
        icon: Icons.hourglass_empty,
        loading: true,
      ),
    ),
  );
}

final class FilterSelection {
  const FilterSelection({this.statuses = const {}});
  final Set<String> statuses;
  int get activeCount => statuses.length;
}

Future<FilterSelection?> showOrderFilters(
  BuildContext context, {
  required FilterSelection initial,
}) => showModalBottomSheet<FilterSelection>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (context) => _FilterSheet(initial: initial),
);

final class _FilterSheet extends StatefulWidget {
  const _FilterSheet({required this.initial});
  final FilterSelection initial;
  @override
  State<_FilterSheet> createState() => _FilterSheetState();
}

final class _FilterSheetState extends State<_FilterSheet> {
  late Set<String> statuses = {...widget.initial.statuses};
  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final options = <String, String>{
      'new': l10n.newStatus,
      'assigned': l10n.assignedToDriver,
      'out_for_delivery': l10n.outForDelivery,
      'delivered': l10n.delivered,
      'returned_to_branch': l10n.returnedToBranch,
      'returned_to_trader': l10n.returnedToTrader,
      'cancelled': l10n.cancelled,
    };
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l10n.filters, style: Theme.of(context).textTheme.titleLarge),
            Flexible(
              child: SingleChildScrollView(
                child: Wrap(
                  spacing: AppSpacing.sm,
                  children: [
                    for (final option in options.entries)
                      FilterChip(
                        label: Text(option.value),
                        selected: statuses.contains(option.key),
                        onSelected: (selected) => setState(() {
                          selected
                              ? statuses.add(option.key)
                              : statuses.remove(option.key);
                        }),
                      ),
                  ],
                ),
              ),
            ),
            Row(
              children: [
                TextButton(
                  onPressed: () => setState(statuses.clear),
                  child: Text(l10n.clear),
                ),
                const Spacer(),
                FilledButton(
                  onPressed: () => Navigator.pop(
                    context,
                    FilterSelection(statuses: statuses),
                  ),
                  child: Text(l10n.apply),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
