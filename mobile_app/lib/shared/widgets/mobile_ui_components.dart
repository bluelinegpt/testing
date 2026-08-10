import 'dart:async';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart' as intl;

/// The single shared DEV-only diagnostic text for a failed data load —
/// previously duplicated near-identically as a private `_devError` in both
/// `dashboard_page.dart` and `operator_pages.dart`, and entirely absent from
/// `driver_pages.dart` (whose two `AppErrorState` call sites fell back to
/// the same generic "Data is currently unavailable" text with zero way to
/// tell which category — network/timeout/HTTP status/invalid response —
/// actually failed). [screen] identifies which screen/endpoint failed, since
/// `AppErrorState` itself has no way to know that. Never includes a response
/// body, token, or other payload content — only the failure's kind/code/HTTP
/// status, matching the existing DEV-diagnostics convention used at login
/// (`_LoginDiagnostics` in `pages.dart`).
String devApiFailureText(String screen, Object error) {
  if (error is ApiFailure) {
    final status = error.statusCode == null
        ? ''
        : 'HTTP ${error.statusCode} — ';
    return 'DEV $screen: $status${error.code ?? error.kind.name.toUpperCase()}';
  }
  return 'DEV $screen: UNKNOWN_ERROR';
}

enum OrderStatusPresentation {
  newOrder,
  assigned,
  outForDelivery,
  onHold,
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
    'hold' => OrderStatusPresentation.onHold,
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
        OrderStatusPresentation.onHold => l10n.holdStatus,
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
      OrderStatusPresentation.returnedToTrader ||
      OrderStatusPresentation.onHold => AppColors.warning,
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
    final scheme = Theme.of(context).colorScheme;
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
              mainAxisSize: MainAxisSize.max,
              children: [
                Container(
                  padding: const EdgeInsets.all(AppSpacing.xs),
                  decoration: BoxDecoration(
                    color: scheme.primary.withValues(alpha: 0.1),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(icon, size: 20, color: scheme.primary),
                ),
                const Spacer(),
                if (loading)
                  const LinearProgressIndicator()
                else
                  Text(
                    formatted,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                const SizedBox(height: AppSpacing.xs / 2),
                Text(
                  title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
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
    final theme = Theme.of(context);
    final mutedStyle = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    // Serial/Reference — whichever is available — is the card's primary,
    // emphasized identifier; the raw internal `orderNumber` becomes a
    // smaller secondary line rather than disappearing outright. When
    // neither is available, `orderNumber` is shown at full emphasis instead
    // (never left with no primary identifier at all).
    final reference = order.externalReference?.trim();
    final serial = order.serialNumber?.trim();
    final primaryLabel = (reference != null && reference.isNotEmpty)
        ? reference
        : (serial != null && serial.isNotEmpty)
        ? serial
        : order.orderNumber;
    final showSecondaryOrderNumber = primaryLabel != order.orderNumber;
    final areaLine = [
      order.emirate,
      order.area,
    ].whereType<String>().where((value) => value.trim().isNotEmpty).join(', ');
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Serial/Reference (primary) + internal order number
              // (secondary) always sit on the left; the status chip always
              // sits trailing, in a single fixed position.
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Directionality(
                      textDirection: TextDirection.ltr,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            primaryLabel,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          if (showSecondaryOrderNumber)
                            Text(order.orderNumber, style: mutedStyle),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  StatusChip(status: order.status),
                ],
              ),
              if (showCustomer &&
                  (order.customerName != null || areaLine.isNotEmpty)) ...[
                const SizedBox(height: AppSpacing.xs),
                // A single compact customer + area summary line instead of
                // two separately-stacked, unlabeled Text rows.
                Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: AppSpacing.xs,
                  children: [
                    if (order.customerName != null) Text(order.customerName!),
                    if (order.customerName != null && areaLine.isNotEmpty)
                      Text('•', style: mutedStyle),
                    if (areaLine.isNotEmpty) Text(areaLine, style: mutedStyle),
                  ],
                ),
              ],
              if (showCustomer && order.mobileNumber != null) ...[
                const SizedBox(height: AppSpacing.xs / 2),
                Directionality(
                  textDirection: TextDirection.ltr,
                  child: Text(order.mobileNumber!, style: mutedStyle),
                ),
              ],
              if (showCustomer && order.addressSummary != null) ...[
                const SizedBox(height: AppSpacing.xs / 2),
                Text(
                  order.addressSummary!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: mutedStyle,
                ),
              ],
              // COD/fee figures stay a compact, muted line — visible, but
              // never a giant figure competing with the Serial/status above.
              if ((showTraderMoney && order.cod != null) ||
                  (showTraderMoney && order.deliveryFee != null)) ...[
                const SizedBox(height: AppSpacing.xs),
                Wrap(
                  spacing: AppSpacing.sm,
                  children: [
                    if (showTraderMoney && order.cod != null)
                      Text('${l10n.cod}: AED ${order.cod}', style: mutedStyle),
                    if (showTraderMoney && order.deliveryFee != null)
                      Text(
                        '${l10n.deliveryFee}: AED ${order.deliveryFee}',
                        style: mutedStyle,
                      ),
                  ],
                ),
              ],
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
