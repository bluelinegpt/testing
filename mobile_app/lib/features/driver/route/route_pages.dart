import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
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

  Future<void> _replanAsked(RouteRun run) async {
    if (run.manualOrder) {
      final l10n = AppLocalizations.of(context);
      final replace = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          content: Text(l10n.routeReplanConfirm),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(l10n.routeCancel),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: Text(l10n.routeReplanConfirmAction),
            ),
          ],
        ),
      );
      if (replace != true) return;
    }
    await _replan(run);
  }

  /// Saves the Driver's own order. The screen shows the new order at once;
  /// if saving fails it goes back to what the server holds.
  Future<void> _saveOrder(RouteRun run, List<RouteArea> areas) => _run(
    (key) => ref
        .read(driverRouteRepositoryProvider)
        .reorder(
          key,
          run.revision,
          [for (final area in areas) area.areaId],
          orderIds: [
            for (final area in areas)
              for (final order in area.orders) order.id,
          ],
        ),
  );

  Future<void> _moveArea(RouteRun run, int from, int to) {
    final areas = [...run.areas];
    final moved = areas.removeAt(from);
    areas.insert(to > from ? to - 1 : to, moved);
    return _saveOrder(run, areas);
  }

  Future<void> _moveOrder(RouteRun run, RouteArea area, int index, int step) {
    final orders = [...area.orders];
    final target = index + step;
    if (target < 0 || target >= orders.length) return Future.value();
    final moved = orders.removeAt(index);
    orders.insert(target, moved);
    final areas = [
      for (final candidate in run.areas)
        candidate.areaId == area.areaId
            ? candidate.withOrders(orders)
            : candidate,
    ];
    return _saveOrder(run, areas);
  }

  Future<void> _startTrip(RouteRun run) async {
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.routeStartTripConfirmTitle),
        content: Text(l10n.routeStartTripConfirmBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.routeCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.routeStartTrip),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await _run((key) => ref.read(driverRouteRepositoryProvider).start(key));
    if (!mounted) return;
    final changed = _state.tripChangedCount;
    if (changed != null) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            _state.tripFailedCount > 0
                ? '${l10n.routeStartTripDone(changed)} ${l10n.routeStartTripSomeFailed}'
                : l10n.routeStartTripDone(changed),
          ),
        ),
      );
    }
  }

  Future<void> _noAnswer(RouteOrder order) => _run(
    (key) => ref.read(driverRouteRepositoryProvider).noAnswer(key, order.id),
  );

  Future<void> _openOrder(RouteOrder order) async {
    if (order.id.isEmpty) return;
    await context.push('/orders/${order.id}');
    if (mounted) await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final run = _state.run;
    final actionsEnabled = !_busy && !_state.offline;
    final notices = <Widget>[
      if (_state.offline)
        _Notice(
          icon: Icons.cloud_off_outlined,
          color: AppColors.warning,
          text: l10n.routeOfflineNotice,
        ),
      if (run != null && run.isFallback)
        _Notice(
          icon: Icons.info_outline,
          color: AppColors.info,
          text: l10n.routeFallbackNotice,
        ),
      if (run != null && run.partialOptimization)
        _Notice(
          icon: Icons.info_outline,
          color: AppColors.info,
          text: l10n.routePartialNotice,
        ),
    ];
    if (run != null && run.isStarted) {
      return RefreshIndicator(
        onRefresh: _refresh,
        child: _TripView(
          run: run,
          locale: locale,
          notices: notices,
          actionsEnabled: actionsEnabled,
          onOpenOrder: _openOrder,
          onNoAnswer: _noAnswer,
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          ...notices,
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
            Text(
              '${l10n.routeTabRoute} ${run.referenceNumber}'
              '${!run.isFallback && run.distanceMeters != null ? ' · ${l10n.routeEstimate} ${(run.distanceMeters! / 1000).toStringAsFixed(1)} ${l10n.routeKm}' : ''}'
              '${!run.isFallback && run.durationSeconds != null ? ' · ${(run.durationSeconds! / 60).round()} ${l10n.routeMinutes}' : ''}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              children: [
                OutlinedButton.icon(
                  onPressed: actionsEnabled ? () => _replanAsked(run) : null,
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
            if (run.areas.isEmpty)
              AppEmptyState(message: l10n.routeNoStops)
            else ...[
              Text(
                l10n.routeArrangeHint,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.sm),
              ReorderableListView(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                buildDefaultDragHandles: false,
                onReorder: (from, to) {
                  if (actionsEnabled) _moveArea(run, from, to);
                },
                children: [
                  for (final (index, area) in run.areas.indexed)
                    _AreaTile(
                      key: ValueKey(area.areaId),
                      index: index,
                      area: area,
                      locale: locale,
                      actionsEnabled: actionsEnabled,
                      onDefer: (order) => _defer(run, order),
                      onOpenMaps: () => _openMaps(area),
                      onOpenOrder: _openOrder,
                      onMoveOrder: (orderIndex, step) =>
                          _moveOrder(run, area, orderIndex, step),
                    ),
                ],
              ),
            ],
            if (run.deferredOrders.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.md),
              Text(
                l10n.routeDeferred,
                style: Theme.of(context).textTheme.titleSmall,
              ),
              for (final order in run.deferredOrders)
                _OrderTile(order: order, onTap: () => _openOrder(order)),
            ],
            const SizedBox(height: AppSpacing.md),
            FilledButton.icon(
              onPressed: actionsEnabled && run.areas.isNotEmpty
                  ? () => _startTrip(run)
                  : null,
              icon: const Icon(Icons.play_arrow_rounded),
              label: Text(l10n.routeStartTrip),
            ),
          ],
        ],
      ),
    );
  }
}

/// The trip, one stop at a time. A "no answer" only moves the Driver on:
/// the Order keeps its status and stays under "try again", and he can open
/// it whenever he comes back.
final class _TripView extends StatelessWidget {
  const _TripView({
    required this.run,
    required this.locale,
    required this.notices,
    required this.actionsEnabled,
    required this.onOpenOrder,
    required this.onNoAnswer,
  });

  final RouteRun run;
  final String locale;
  final List<Widget> notices;
  final bool actionsEnabled;
  final Future<void> Function(RouteOrder order) onOpenOrder;
  final Future<void> Function(RouteOrder order) onNoAnswer;

  Future<void> _open(BuildContext context, Uri? uri) async {
    if (uri == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.externalAppUnavailable)),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final plan = TripPlan.of(run);
    final current = plan.current;
    final upNext = plan.untried.skip(1).toList();
    final retry = plan.retry;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        ...notices,
        Text(
          '${l10n.routeTripStarted} · ${run.referenceNumber} · '
          '${l10n.routeStopsLeft(plan.total)}',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.sm),
        if (current != null)
          _CurrentStopCard(
            stop: current,
            locale: locale,
            actionsEnabled: actionsEnabled,
            onOpen: (uri) => _open(context, uri),
            onOpenOrder: () => onOpenOrder(current.order),
            onNoAnswer: () => onNoAnswer(current.order),
          ),
        if (upNext.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.md),
          Text(l10n.routeUpNext, style: theme.textTheme.titleSmall),
          for (final stop in upNext)
            _OrderTile(
              order: stop.order,
              area: stop.area,
              locale: locale,
              onTap: () => onOpenOrder(stop.order),
            ),
        ],
        if (retry.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.md),
          Text(l10n.routeRetryTitle, style: theme.textTheme.titleSmall),
          for (final stop in retry)
            _OrderTile(
              order: stop.order,
              area: stop.area,
              locale: locale,
              onTap: () => onOpenOrder(stop.order),
            ),
        ],
        if (current == null) ...[
          const SizedBox(height: AppSpacing.md),
          BluelineSectionCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (plan.isFinished)
                  Text(l10n.routeTripFinished, style: theme.textTheme.titleMedium),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  '${l10n.routeReturnToBranch}: AED ${run.cashHandoverAmount}'
                  ' (${run.cashHandoverOrderCount} ${l10n.routeOrders})',
                ),
                if (run.hasBranch) ...[
                  const SizedBox(height: AppSpacing.sm),
                  FilledButton.icon(
                    onPressed: () => _open(
                      context,
                      pointDirectionsUri(
                        run.branchLatitude!,
                        run.branchLongitude!,
                      ),
                    ),
                    icon: const Icon(Icons.navigation_outlined),
                    label: Text(l10n.routeNavigateToBranch),
                  ),
                ],
              ],
            ),
          ),
        ],
      ],
    );
  }
}

final class _CurrentStopCard extends StatelessWidget {
  const _CurrentStopCard({
    required this.stop,
    required this.locale,
    required this.actionsEnabled,
    required this.onOpen,
    required this.onOpenOrder,
    required this.onNoAnswer,
  });

  final TripStop stop;
  final String locale;
  final bool actionsEnabled;
  final Future<void> Function(Uri? uri) onOpen;
  final VoidCallback onOpenOrder;
  final VoidCallback onNoAnswer;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final order = stop.order;
    final area = stop.area;
    final mobile = order.customerMobile ?? '';
    final address = order.customerAddress ?? '';
    final message = l10n.routeOnMyWayMessage(
      (order.customerName ?? '').trim(),
      order.label,
    );
    return BluelineSectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(l10n.routeCurrentStop, style: theme.textTheme.labelMedium),
          Text(
            '${area.areaName(locale)} · ${area.emirateName(locale)}',
            style: theme.textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(order.customerName ?? order.orderNumber),
          Text(order.label, style: theme.textTheme.bodySmall),
          if (address.trim().isNotEmpty) Text(address),
          if (order.amountDue case final amount?)
            Text(
              '${l10n.routeCollect}: AED $amount',
              style: theme.textTheme.titleSmall,
            ),
          const SizedBox(height: AppSpacing.sm),
          FilledButton.icon(
            onPressed: () => onOpen(
              orderDirectionsUri(
                address: address,
                areaName: area.areaName(locale),
                emirateName: area.emirateName(locale),
                latitude: area.latitude,
                longitude: area.longitude,
              ),
            ),
            icon: const Icon(Icons.navigation_outlined),
            label: Text(l10n.routeNavigate),
          ),
          const SizedBox(height: AppSpacing.xs),
          Wrap(
            spacing: AppSpacing.xs,
            runSpacing: AppSpacing.xs,
            children: [
              OutlinedButton.icon(
                onPressed: customerCallUri(mobile) == null
                    ? null
                    : () => onOpen(customerCallUri(mobile)),
                icon: const Icon(Icons.call_outlined),
                label: Text(l10n.callCustomer),
              ),
              OutlinedButton.icon(
                onPressed: customerWhatsAppUri(mobile, message) == null
                    ? null
                    : () => onOpen(customerWhatsAppUri(mobile, message)),
                icon: const Icon(Icons.chat_outlined),
                label: Text(l10n.whatsAppCustomer),
              ),
              OutlinedButton.icon(
                onPressed: customerSmsUri(mobile, message) == null
                    ? null
                    : () => onOpen(customerSmsUri(mobile, message)),
                icon: const Icon(Icons.sms_outlined),
                label: Text(l10n.smsCustomer),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: [
              Expanded(
                child: FilledButton.tonal(
                  onPressed: onOpenOrder,
                  child: Text(l10n.routeOpenOrder),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: OutlinedButton(
                  onPressed: actionsEnabled ? onNoAnswer : null,
                  child: Text(l10n.routeNoAnswerNext),
                ),
              ),
            ],
          ),
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
    required this.index,
    required this.area,
    required this.locale,
    required this.actionsEnabled,
    required this.onDefer,
    required this.onOpenMaps,
    required this.onOpenOrder,
    required this.onMoveOrder,
    super.key,
  });

  final int index;
  final RouteArea area;
  final String locale;
  final bool actionsEnabled;
  final void Function(RouteOrder order) onDefer;
  final VoidCallback onOpenMaps;
  final void Function(RouteOrder order) onOpenOrder;
  final void Function(int orderIndex, int step) onMoveOrder;

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
              : Text('${index + 1}'),
        ),
        title: Text(area.areaName(locale)),
        subtitle: Text(tag == null ? subtitle : '$subtitle · $tag'),
        trailing: ReorderableDragStartListener(
          index: index,
          enabled: actionsEnabled,
          child: const Padding(
            padding: EdgeInsets.all(AppSpacing.xs),
            child: Icon(Icons.drag_handle),
          ),
        ),
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
          for (final (orderIndex, order) in area.orders.indexed)
            _OrderTile(
              order: order,
              onTap: () => onOpenOrder(order),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    tooltip: l10n.routeMoveUp,
                    visualDensity: VisualDensity.compact,
                    onPressed: actionsEnabled && orderIndex > 0
                        ? () => onMoveOrder(orderIndex, -1)
                        : null,
                    icon: const Icon(Icons.arrow_upward, size: 18),
                  ),
                  IconButton(
                    tooltip: l10n.routeMoveDown,
                    visualDensity: VisualDensity.compact,
                    onPressed:
                        actionsEnabled && orderIndex < area.orders.length - 1
                        ? () => onMoveOrder(orderIndex, 1)
                        : null,
                    icon: const Icon(Icons.arrow_downward, size: 18),
                  ),
                  TextButton(
                    onPressed: actionsEnabled ? () => onDefer(order) : null,
                    child: Text(l10n.routeDefer),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

final class _OrderTile extends StatelessWidget {
  const _OrderTile({
    required this.order,
    this.trailing,
    this.onTap,
    this.area,
    this.locale = 'en',
  });
  final RouteOrder order;
  final Widget? trailing;
  final VoidCallback? onTap;
  final RouteArea? area;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      dense: true,
      title: Text(order.customerName ?? order.orderNumber),
      subtitle: Text(
        [
          order.label,
          if (area case final place?) place.areaName(locale),
          if (order.noAnswerCount > 0)
            '${l10n.routeNoAnswerCount} ×${order.noAnswerCount}',
        ].join(' · '),
      ),
      trailing: trailing,
      onTap: order.id.isEmpty ? null : onTap,
    );
  }
}
