import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_pages.dart';
import 'package:bluelinegpt_mobile/features/driver/route/route_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:uuid/uuid.dart';

/// The Driver's Orders screen with route planning (Areas, not addresses).
///
/// When route planning is switched on for the Company, the screen gets two
/// tabs: "My Orders" -- the list exactly as before -- and "Route". When it is
/// off, unreachable on first open with nothing saved, or the call fails for
/// any other reason, the plain Orders list is shown unchanged and no tab
/// appears.
final class DriverOrdersWithRouteTabs extends ConsumerStatefulWidget {
  const DriverOrdersWithRouteTabs({
    super.key,
    this.initialDeliveryStatus,
    this.ordersList,
  });
  final String? initialDeliveryStatus;

  /// The My Orders tab. Defaults to the Driver account's list; a Driver User
  /// (Company user linked to a Driver) passes their own Orders list here.
  final Widget? ordersList;

  @override
  ConsumerState<DriverOrdersWithRouteTabs> createState() =>
      _DriverOrdersWithRouteTabsState();
}

final class _DriverOrdersWithRouteTabsState
    extends ConsumerState<DriverOrdersWithRouteTabs> {
  late final Future<RouteState> _route;

  @override
  void initState() {
    super.initState();
    _route = ref
        .read(driverRouteRepositoryProvider)
        .current()
        .catchError((Object _) => const RouteState(enabled: false));
  }

  @override
  Widget build(BuildContext context) {
    final orders =
        widget.ordersList ??
        DriverOrdersPage(initialDeliveryStatus: widget.initialDeliveryStatus);
    return FutureBuilder<RouteState>(
      future: _route,
      builder: (context, snapshot) {
        final state = snapshot.data;
        if (state == null || !state.enabled) return orders;
        final l10n = AppLocalizations.of(context);
        return DefaultTabController(
          length: 2,
          child: Column(
            children: [
              TabBar(
                tabs: [
                  Tab(text: l10n.routeTabMyOrders),
                  Tab(text: l10n.routeTabRoute),
                ],
              ),
              Expanded(
                child: TabBarView(
                  children: [
                    orders,
                    DriverRoutePage(initial: state),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// The Route tab: plan, follow the Area sequence, defer an Order, replan or
/// reverse. The sequence is advice: the Driver may work in any order and is
/// never warned for going off-sequence.
final class DriverRoutePage extends ConsumerStatefulWidget {
  const DriverRoutePage({required this.initial, super.key});
  final RouteState initial;

  @override
  ConsumerState<DriverRoutePage> createState() => _DriverRoutePageState();
}

final class _DriverRoutePageState extends ConsumerState<DriverRoutePage> {
  static const _uuid = Uuid();
  late RouteState _state = widget.initial;
  bool _busy = false;

  Future<void> _run(Future<RouteState> Function(String key) action) async {
    if (_busy) return;
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      final next = await action(_uuid.v4());
      if (!mounted) return;
      setState(() => _state = next);
      if (next.stale) {
        messenger.showSnackBar(SnackBar(content: Text(l10n.routeStaleNotice)));
      }
    } on Object {
      if (mounted) {
        messenger.showSnackBar(SnackBar(content: Text(l10n.routeActionFailed)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refresh() =>
      _run((_) => ref.read(driverRouteRepositoryProvider).current());

  Future<void> _plan({String? startAreaId}) => _run(
    (key) => ref
        .read(driverRouteRepositoryProvider)
        .plan(key, startAreaId: startAreaId),
  );

  Future<void> _replan(RouteRun run) => _run(
    (key) => ref.read(driverRouteRepositoryProvider).replan(key, run.revision),
  );

  Future<void> _reverse(RouteRun run) => _run(
    (key) => ref.read(driverRouteRepositoryProvider).reverse(key, run.revision),
  );

  Future<void> _defer(RouteRun run, RouteOrder order) => _run(
    (key) => ref
        .read(driverRouteRepositoryProvider)
        .defer(key, order.id, run.revision),
  );

  /// The start Area is chosen from the Areas of the Driver's own Orders.
  Future<void> _pickStartArea() async {
    final l10n = AppLocalizations.of(context);
    final orders = await ref.read(driverRepositoryProvider).orders();
    if (!mounted) return;
    final areas = <String, String>{};
    for (final order in orders) {
      if (order.status == 'assigned_to_driver' ||
          order.status == 'out_for_delivery') {
        areas[order.areaId] = order.areaName;
      }
    }
    final chosen = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            ListTile(
              title: Text(
                l10n.routeChooseArea,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            for (final entry in areas.entries)
              ListTile(
                title: Text(entry.value),
                onTap: () => Navigator.of(context).pop(entry.key),
              ),
          ],
        ),
      ),
    );
    if (chosen != null) await _plan(startAreaId: chosen);
  }

  Future<void> _openMaps(RouteArea area) async {
    if (!area.hasPin) return;
    final uri = Uri.parse(
      'https://www.google.com/maps/search/?api=1&query=${area.latitude},${area.longitude}',
    );
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final run = _state.run;
    final actionsEnabled = !_busy && !_state.offline;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          if (_state.offline)
            _Notice(
              icon: Icons.cloud_off_outlined,
              color: AppColors.warning,
              text: l10n.routeOfflineNotice,
            ),
          if (run == null) ...[
            BluelineSectionCard(child: Text(l10n.routeIntro)),
            const SizedBox(height: AppSpacing.md),
            FilledButton.icon(
              onPressed: actionsEnabled ? () => _plan() : null,
              icon: const Icon(Icons.route),
              label: Text(l10n.routePlanFromBranch),
            ),
            const SizedBox(height: AppSpacing.sm),
            OutlinedButton.icon(
              onPressed: actionsEnabled ? _pickStartArea : null,
              icon: const Icon(Icons.place_outlined),
              label: Text(l10n.routePlanFromArea),
            ),
          ] else ...[
            if (run.isFallback)
              _Notice(
                icon: Icons.info_outline,
                color: AppColors.info,
                text: l10n.routeFallbackNotice,
              ),
            if (run.partialOptimization)
              _Notice(
                icon: Icons.info_outline,
                color: AppColors.info,
                text: l10n.routePartialNotice,
              ),
            Row(
              children: [
                Expanded(
                  child: Text(
                    '${l10n.routeTabRoute} ${run.referenceNumber}'
                    '${!run.isFallback && run.distanceMeters != null ? ' · ${l10n.routeEstimate} ${(run.distanceMeters! / 1000).toStringAsFixed(1)} ${l10n.routeKm}' : ''}'
                    '${!run.isFallback && run.durationSeconds != null ? ' · ${(run.durationSeconds! / 60).round()} ${l10n.routeMinutes}' : ''}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              children: [
                OutlinedButton.icon(
                  onPressed: actionsEnabled ? () => _replan(run) : null,
                  icon: const Icon(Icons.refresh),
                  label: Text(l10n.routeReplan),
                ),
                OutlinedButton.icon(
                  onPressed: actionsEnabled ? () => _reverse(run) : null,
                  icon: const Icon(Icons.swap_vert),
                  label: Text(l10n.routeReverse),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            if (run.nextArea case final next?)
              BluelineSectionCard(
                child: Row(
                  children: [
                    const Icon(Icons.flag_outlined, color: AppColors.primary),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            l10n.routeNextArea,
                            style: Theme.of(context).textTheme.labelMedium,
                          ),
                          Text(
                            next.areaName(locale),
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          Text('${next.orderCount} ${l10n.routeOrders}'),
                        ],
                      ),
                    ),
                    if (next.hasPin)
                      IconButton(
                        tooltip: l10n.routeOpenInMaps,
                        onPressed: () => _openMaps(next),
                        icon: const Icon(Icons.map_outlined),
                      ),
                  ],
                ),
              ),
            const SizedBox(height: AppSpacing.sm),
            if (run.areas.isEmpty) AppEmptyState(message: l10n.routeNoStops),
            for (final area in run.areas)
              _AreaTile(
                area: area,
                locale: locale,
                actionsEnabled: actionsEnabled,
                onDefer: (order) => _defer(run, order),
                onOpenMaps: () => _openMaps(area),
              ),
            if (run.deferredOrders.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.md),
              Text(
                l10n.routeDeferred,
                style: Theme.of(context).textTheme.titleSmall,
              ),
              for (final order in run.deferredOrders) _OrderTile(order: order),
            ],
          ],
        ],
      ),
    );
  }
}

final class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.color, required this.text});
  final IconData icon;
  final Color color;
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.sm),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: AppSpacing.xs),
        Expanded(
          child: Text(text, style: Theme.of(context).textTheme.bodySmall),
        ),
      ],
    ),
  );
}

final class _AreaTile extends StatelessWidget {
  const _AreaTile({
    required this.area,
    required this.locale,
    required this.actionsEnabled,
    required this.onDefer,
    required this.onOpenMaps,
  });

  final RouteArea area;
  final String locale;
  final bool actionsEnabled;
  final void Function(RouteOrder order) onDefer;
  final VoidCallback onOpenMaps;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final subtitle = [
      area.emirateName(locale),
      '${area.orderCount} ${l10n.routeOrders}',
      if (area.cashHandoverCount > 0)
        '${l10n.routeCashHandover}: ${area.cashHandoverCount}',
    ].join(' · ');
    final tag = area.isDone
        ? l10n.routeDone
        : area.isNew
        ? l10n.routeNewArea
        : !area.isSequenced && area.sequencePosition != null && !area.hasPin
        ? l10n.routeUnsequenced
        : null;
    return Card(
      child: ExpansionTile(
        leading: CircleAvatar(
          backgroundColor: area.isDone ? AppColors.success : AppColors.primary,
          foregroundColor: Colors.white,
          child: area.isDone
              ? const Icon(Icons.check, size: 18)
              : Text(area.sequencePosition?.toString() ?? '•'),
        ),
        title: Text(area.areaName(locale)),
        subtitle: Text(tag == null ? subtitle : '$subtitle · $tag'),
        children: [
          if (area.hasPin)
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: TextButton.icon(
                onPressed: onOpenMaps,
                icon: const Icon(Icons.map_outlined),
                label: Text(l10n.routeOpenInMaps),
              ),
            ),
          for (final order in area.orders)
            _OrderTile(
              order: order,
              trailing: TextButton(
                onPressed: actionsEnabled ? () => onDefer(order) : null,
                child: Text(l10n.routeDefer),
              ),
            ),
        ],
      ),
    );
  }
}

final class _OrderTile extends StatelessWidget {
  const _OrderTile({required this.order, this.trailing});
  final RouteOrder order;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => ListTile(
    dense: true,
    title: Text(order.customerName ?? order.orderNumber),
    subtitle: Text(
      [
        order.orderNumber,
        ?order.serialNumber,
        ?order.referenceNumber,
      ].join(' · '),
    ),
    trailing: trailing,
    onTap: order.id.isEmpty ? null : () => context.push('/orders/${order.id}'),
  );
}
