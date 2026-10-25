import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_order_detail_view.dart';
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

  /// Runs one route call; true when it succeeded.
  Future<bool> _run(Future<RouteState> Function(String key) action) async {
    if (_busy) return false;
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      final next = await action(_uuid.v4());
      if (!mounted) return false;
      setState(() => _state = next);
      if (next.stale) {
        messenger.showSnackBar(SnackBar(content: Text(l10n.routeStaleNotice)));
        return false;
      }
      return true;
    } on Object {
      if (mounted) {
        messenger.showSnackBar(SnackBar(content: Text(l10n.routeActionFailed)));
      }
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refresh() =>
      _run((_) => ref.read(driverRouteRepositoryProvider).current());

  /// Like / dislike of today's route (one answer per route; may be changed).
  Future<void> _rate(RouteRun run, {required bool like}) async {
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    if (like) {
      final saved = await _run(
        (_) => ref.read(driverRouteRepositoryProvider).feedback('like'),
      );
      if (saved && mounted) {
        messenger.showSnackBar(SnackBar(content: Text(l10n.routeFeedbackThanks)));
      }
      return;
    }
    final answer = await showModalBottomSheet<_DislikeAnswer>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => _DislikeSheet(
        run: run,
        locale: Localizations.localeOf(context).languageCode,
        initial: run.feedback != null && !run.feedback!.isLike
            ? run.feedback
            : null,
      ),
    );
    if (answer == null || !mounted) return;
    final saved = await _run(
      (_) => ref
          .read(driverRouteRepositoryProvider)
          .feedback(
            'dislike',
            reason: answer.reason,
            comment: answer.comment,
            areaIds: answer.areaIds,
          ),
    );
    if (saved && mounted) {
      messenger.showSnackBar(SnackBar(content: Text(l10n.routeFeedbackThanks)));
    }
  }

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

  /// "Start from an Area": the Area he goes to first (for example the one he
  /// is in now); the rest of the route is arranged from there. The server
  /// lists the Areas of his open Orders, so this works for a Driver User too.
  Future<void> _pickStartArea() async {
    final l10n = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final messenger = ScaffoldMessenger.of(context);
    if (_state.startAreas.isEmpty) {
      await _refresh();
      if (!mounted) return;
    }
    final areas = _state.startAreas;
    if (areas.isEmpty) {
      messenger.showSnackBar(SnackBar(content: Text(l10n.routeNoStartAreas)));
      return;
    }
    final chosen = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.75,
          ),
          child: ListView(
            shrinkWrap: true,
            children: [
              ListTile(
                title: Text(
                  l10n.routeChooseArea,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                subtitle: Text(l10n.routePlanFromAreaHint),
              ),
              for (final area in areas)
                ListTile(
                  leading: const Icon(Icons.place_outlined),
                  title: Text(area.label(locale)),
                  onTap: () => Navigator.of(context).pop(area.areaId),
                ),
            ],
          ),
        ),
      ),
    );
    if (chosen != null) await _plan(startAreaId: chosen);
  }

  /// Asks for a new number (1-based on screen) for the item at [current].
  /// [labels] are what sits at each number now. Returns the 0-based index.
  Future<int?> _pickPosition(String item, List<String> labels, int current) {
    final l10n = AppLocalizations.of(context);
    return showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(context).height * 0.75,
          ),
          child: ListView(
            shrinkWrap: true,
            children: [
              ListTile(
                title: Text(
                  l10n.routeMoveToTitle(item),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              for (final (index, label) in labels.indexed)
                ListTile(
                  selected: index == current,
                  leading: CircleAvatar(
                    radius: 16,
                    child: Text('${index + 1}'),
                  ),
                  title: Text(l10n.routePositionNumber(index + 1)),
                  subtitle: Text(label),
                  onTap: () => Navigator.of(context).pop(index),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _setAreaPosition(RouteRun run, int from) async {
    final locale = Localizations.localeOf(context).languageCode;
    final pending = [
      for (final area in run.areas)
        if (!area.isDone) area,
    ];
    if (pending.length < 2) return;
    final to = await _pickPosition(pending[from].areaName(locale), [
      for (final area in pending) area.areaName(locale),
    ], from);
    if (to == null || to == from || !mounted) return;
    await _moveArea(run, from, to);
  }

  Future<void> _showRouteOnMap(List<TripStop> stops) async {
    final uri = tripOverviewUri(stops);
    if (uri == null) return;
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.externalAppUnavailable)),
      );
    }
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
          // Deferred Orders stay last; an explicit list keeps them in it.
          orderIds: [
            for (final area in areas)
              for (final order in area.orders) order.id,
            for (final order in run.deferredOrders) order.id,
          ],
        ),
  );

  /// Saves the trip's stops in [stops] order: the Areas in the order they
  /// first appear, and every Order in exactly this order.
  Future<bool> _saveStops(RouteRun run, List<TripStop> stops) {
    final known = {for (final area in run.areas) area.areaId};
    final areaIds = <String>[];
    for (final stop in stops) {
      final id = stop.area.areaId;
      if (known.contains(id) && !areaIds.contains(id)) areaIds.add(id);
    }
    return _run(
      (key) => ref
          .read(driverRouteRepositoryProvider)
          .reorder(
            key,
            run.revision,
            areaIds,
            orderIds: [for (final stop in stops) stop.order.id],
          ),
    );
  }

  /// "Next": the current stop goes to the end of the route (no answer,
  /// traffic, anything) and the following one becomes current. The Order
  /// itself is not changed.
  Future<void> _next(RouteRun run) async {
    final plan = TripPlan.of(run);
    if (plan.total < 2) return;
    await _saveStops(run, plan.afterNext);
  }

  /// "Previous": the stop he passed with Next comes back and is current.
  Future<void> _previous(RouteRun run) async {
    final plan = TripPlan.of(run);
    if (plan.total < 2) return;
    await _saveStops(run, plan.afterPrevious);
  }

  /// Moves a whole Area (all its stops) to another place in the trip.
  Future<void> _setTripAreaPosition(RouteRun run, int from) async {
    final locale = Localizations.localeOf(context).languageCode;
    final plan = TripPlan.of(run);
    final areas = plan.areaOrder;
    if (from < 0 || areas.length < 2) return;
    final to = await _pickPosition(areas[from].areaName(locale), [
      for (final area in areas) area.areaName(locale),
    ], from);
    if (to == null || to == from || !mounted) return;
    await _saveStops(run, plan.movedArea(from, to));
  }

  /// Gives the stop at [from] a new number in the route.
  Future<void> _setStopPosition(RouteRun run, int from) async {
    final locale = Localizations.localeOf(context).languageCode;
    final plan = TripPlan.of(run);
    if (plan.total < 2) return;
    final to = await _pickPosition(plan.stops[from].order.label, [
      for (final stop in plan.stops)
        [
          stop.order.label,
          if (stop.area.areaName(locale).isNotEmpty) stop.area.areaName(locale),
        ].join(' · '),
    ], from);
    if (to == null || to == from || !mounted) return;
    await _saveStops(run, plan.moved(from, to));
  }

  /// Delivered, Hold or Return to Branch straight from the trip screen. The
  /// stop leaves the route and the next one becomes current.
  Future<void> _stopStatus(RouteOrder order, String status) async {
    final l10n = AppLocalizations.of(context);
    final messenger = ScaffoldMessenger.of(context);
    String? reason;
    if (status == 'delivered') {
      final confirmed = await promptDriverStatusConfirm(
        context,
        title: '${l10n.confirmStatusChange} (${order.label})',
        confirmLabel: l10n.delivered,
      );
      if (!confirmed || !mounted) return;
    } else {
      reason = await promptDriverStatusReason(
        context,
        title: '${l10n.confirmStatusChange} (${order.label})',
        confirmLabel: status == 'hold' ? l10n.hold : l10n.returnToBranchAction,
      );
      if (reason == null || reason.trim().isEmpty || !mounted) return;
    }
    final done = await _run(
      (key) => ref
          .read(driverRouteRepositoryProvider)
          .changeStopStatus(key, order.id, status, reason: reason?.trim()),
    );
    if (done && mounted) {
      messenger.showSnackBar(SnackBar(content: Text(l10n.routeStopSaved)));
    }
  }

  /// [from] and [to] index the Areas still to visit; finished Areas keep
  /// their place after them.
  Future<void> _moveArea(RouteRun run, int from, int to) {
    final pending = [
      for (final area in run.areas)
        if (!area.isDone) area,
    ];
    final moved = pending.removeAt(from);
    pending.insert(to, moved);
    return _saveOrder(run, [
      ...pending,
      for (final area in run.areas)
        if (area.isDone) area,
    ]);
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
    final pendingAreas = run == null
        ? const <RouteArea>[]
        : [
            for (final area in run.areas)
              if (!area.isDone) area,
          ];
    final doneAreas = run == null
        ? const <RouteArea>[]
        : [
            for (final area in run.areas)
              if (area.isDone) area,
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
          onStatus: _stopStatus,
          onNext: () => _next(run),
          onPrevious: () => _previous(run),
          onSetPosition: (index) => _setStopPosition(run, index),
          onMoveStop: (from, to) =>
              _saveStops(run, TripPlan.of(run).moved(from, to)),
          onMoveArea: (areaIndex) => _setTripAreaPosition(run, areaIndex),
          onShowMap: _showRouteOnMap,
          footer: _RouteFeedbackCard(
            feedback: run.feedback,
            enabled: actionsEnabled,
            onLike: () => _rate(run, like: true),
            onDislike: () => _rate(run, like: false),
          ),
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
                OutlinedButton.icon(
                  onPressed: () => _showRouteOnMap(TripPlan.of(run).stops),
                  icon: const Icon(Icons.map_outlined),
                  label: Text(l10n.routeShowOnMap),
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
            if (pendingAreas.isEmpty)
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
                onReorderItem: (from, to) {
                  if (actionsEnabled) _moveArea(run, from, to);
                },
                children: [
                  for (final (index, area) in pendingAreas.indexed)
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
                      onNumber: actionsEnabled && pendingAreas.length > 1
                          ? () => _setAreaPosition(run, index)
                          : null,
                    ),
                ],
              ),
            ],
            if (doneAreas.isNotEmpty)
              Card(
                child: ExpansionTile(
                  leading: const Icon(
                    Icons.check_circle,
                    color: AppColors.success,
                  ),
                  title: Text('${l10n.routeDone} (${doneAreas.length})'),
                  children: [
                    for (final area in doneAreas)
                      ListTile(
                        dense: true,
                        title: Text(area.areaName(locale)),
                        subtitle: Text(area.emirateName(locale)),
                      ),
                  ],
                ),
              ),
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
              onPressed: actionsEnabled && pendingAreas.isNotEmpty
                  ? () => _startTrip(run)
                  : null,
              icon: const Icon(Icons.play_arrow_rounded),
              label: Text(l10n.routeStartTrip),
            ),
            const SizedBox(height: AppSpacing.md),
            _RouteFeedbackCard(
              feedback: run.feedback,
              enabled: actionsEnabled,
              onLike: () => _rate(run, like: true),
              onDislike: () => _rate(run, like: false),
            ),
          ],
        ],
      ),
    );
  }
}

/// The trip. Two views, one tap apart:
/// - "Current stop": everything the Driver needs at the door (Delivered,
///   Hold, Return to branch, Previous, Next, Call/WhatsApp/SMS).
/// - "Route list": every stop still to do, grouped by Area and numbered in
///   order. He can move an Order up or down, give it another number, or move
///   a whole Area.
final class _TripView extends StatefulWidget {
  const _TripView({
    required this.run,
    required this.locale,
    required this.notices,
    required this.actionsEnabled,
    required this.onOpenOrder,
    required this.onStatus,
    required this.onNext,
    required this.onPrevious,
    required this.onSetPosition,
    required this.onMoveStop,
    required this.onMoveArea,
    required this.onShowMap,
    this.footer,
  });

  final RouteRun run;
  final String locale;
  final List<Widget> notices;
  final bool actionsEnabled;
  final Future<void> Function(RouteOrder order) onOpenOrder;
  final Future<void> Function(RouteOrder order, String status) onStatus;
  final Future<void> Function() onNext;
  final Future<void> Function() onPrevious;
  final Future<void> Function(int index) onSetPosition;
  final Future<void> Function(int from, int to) onMoveStop;
  final Future<void> Function(int areaIndex) onMoveArea;
  final Future<void> Function(List<TripStop> stops) onShowMap;

  /// Shown under the trip (the route feedback card).
  final Widget? footer;

  @override
  State<_TripView> createState() => _TripViewState();
}

final class _TripViewState extends State<_TripView> {
  bool _showList = false;

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
    final run = widget.run;
    final plan = TripPlan.of(run);
    final current = plan.current;
    final canMove = widget.actionsEnabled && plan.total > 1;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        ...widget.notices,
        Text(
          '${l10n.routeTripStarted} · ${run.referenceNumber} · '
          '${l10n.routeStopsLeft(plan.total)}',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.sm),
        if (plan.total > 0) ...[
          SegmentedButton<bool>(
            showSelectedIcon: false,
            segments: [
              ButtonSegment(
                value: false,
                icon: const Icon(Icons.local_shipping_outlined),
                label: Text(l10n.routeCurrentStop),
              ),
              ButtonSegment(
                value: true,
                icon: const Icon(Icons.format_list_numbered),
                label: Text(l10n.routeListTab(plan.total)),
              ),
            ],
            selected: {_showList},
            onSelectionChanged: (selection) =>
                setState(() => _showList = selection.first),
          ),
          const SizedBox(height: AppSpacing.sm),
        ],
        if (current != null && !_showList)
          _CurrentStopCard(
            stop: current,
            following: plan.following,
            locale: widget.locale,
            actionsEnabled: widget.actionsEnabled,
            canMove: plan.total > 1,
            onOpen: (uri) => _open(context, uri),
            onDetails: () => widget.onOpenOrder(current.order),
            onStatus: (status) => widget.onStatus(current.order, status),
            onNext: widget.onNext,
            onPrevious: widget.onPrevious,
          ),
        if (current != null && _showList) ...[
          Row(
            children: [
              Expanded(
                child: Text(
                  plan.total > 1 ? l10n.routeListHint : '',
                  style: theme.textTheme.bodySmall,
                ),
              ),
              TextButton.icon(
                onPressed: () => widget.onShowMap(plan.stops),
                icon: const Icon(Icons.map_outlined),
                label: Text(l10n.routeShowOnMap),
              ),
            ],
          ),
          for (final (groupIndex, group) in plan.areaGroups.indexed)
            Card(
              key: ValueKey('route-group-$groupIndex'),
              margin: const EdgeInsets.only(bottom: AppSpacing.sm),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ListTile(
                    leading: const Icon(Icons.place_outlined),
                    title: Text(
                      group.area.areaName(widget.locale).isEmpty
                          ? '—'
                          : group.area.areaName(widget.locale),
                      style: theme.textTheme.titleSmall,
                    ),
                    subtitle: Text(
                      [
                        if (group.area.emirateName(widget.locale).isNotEmpty)
                          group.area.emirateName(widget.locale),
                        '${group.stops.length} ${l10n.routeOrders}',
                      ].join(' · '),
                    ),
                    trailing: plan.areaOrder.length > 1
                        ? IconButton(
                            tooltip: l10n.routeMoveArea,
                            onPressed: widget.actionsEnabled
                                ? () => widget.onMoveArea(
                                    plan.areaOrder.indexWhere(
                                      (area) =>
                                          area.areaId == group.area.areaId,
                                    ),
                                  )
                                : null,
                            icon: const Icon(Icons.swap_vert),
                          )
                        : null,
                  ),
                  for (final (index, stop) in group.stops)
                    _StopTile(
                      number: index + 1,
                      stop: stop,
                      isCurrent: index == 0,
                      onNumber: canMove
                          ? () => widget.onSetPosition(index)
                          : null,
                      onUp: canMove && index > 0
                          ? () => widget.onMoveStop(index, index - 1)
                          : null,
                      onDown: canMove && index < plan.total - 1
                          ? () => widget.onMoveStop(index, index + 1)
                          : null,
                      onTap: () => widget.onOpenOrder(stop.order),
                    ),
                ],
              ),
            ),
        ],
        if (current == null) ...[
          const SizedBox(height: AppSpacing.md),
          BluelineSectionCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (plan.isFinished)
                  Text(
                    l10n.routeTripFinished,
                    style: theme.textTheme.titleMedium,
                  ),
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
        if (widget.footer case final footer?) ...[
          const SizedBox(height: AppSpacing.md),
          footer,
        ],
      ],
    );
  }
}

/// "How is this route?" with a like and a dislike. The answer the Driver
/// gave stays highlighted; tapping again changes it.
final class _RouteFeedbackCard extends StatelessWidget {
  const _RouteFeedbackCard({
    required this.feedback,
    required this.enabled,
    required this.onLike,
    required this.onDislike,
  });

  final RouteFeedback? feedback;
  final bool enabled;
  final VoidCallback onLike;
  final VoidCallback onDislike;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final liked = feedback?.isLike == true;
    final disliked = feedback != null && !feedback!.isLike;
    return BluelineSectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(l10n.routeFeedbackQuestion, style: theme.textTheme.titleSmall),
          if (feedback != null)
            Text(l10n.routeFeedbackGiven, style: theme.textTheme.bodySmall),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: [
              Expanded(
                child: liked
                    ? FilledButton.icon(
                        key: const ValueKey('route-feedback-like'),
                        onPressed: enabled ? onLike : null,
                        icon: const Icon(Icons.thumb_up),
                        label: Text(l10n.routeFeedbackLike),
                      )
                    : OutlinedButton.icon(
                        key: const ValueKey('route-feedback-like'),
                        onPressed: enabled ? onLike : null,
                        icon: const Icon(Icons.thumb_up_outlined),
                        label: Text(l10n.routeFeedbackLike),
                      ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: disliked
                    ? FilledButton.icon(
                        key: const ValueKey('route-feedback-dislike'),
                        style: FilledButton.styleFrom(
                          backgroundColor: AppColors.warning,
                        ),
                        onPressed: enabled ? onDislike : null,
                        icon: const Icon(Icons.thumb_down),
                        label: Text(l10n.routeFeedbackDislike),
                      )
                    : OutlinedButton.icon(
                        key: const ValueKey('route-feedback-dislike'),
                        onPressed: enabled ? onDislike : null,
                        icon: const Icon(Icons.thumb_down_outlined),
                        label: Text(l10n.routeFeedbackDislike),
                      ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

final class _DislikeAnswer {
  const _DislikeAnswer({required this.reason, this.comment, this.areaIds});
  final String reason;
  final String? comment;
  final List<String>? areaIds;
}

/// Why the route was not good: one reason, the Areas for a wrong location,
/// and an optional comment.
final class _DislikeSheet extends StatefulWidget {
  const _DislikeSheet({required this.run, required this.locale, this.initial});
  final RouteRun run;
  final String locale;
  final RouteFeedback? initial;

  @override
  State<_DislikeSheet> createState() => _DislikeSheetState();
}

final class _DislikeSheetState extends State<_DislikeSheet> {
  static const _reasons = [
    'wrong_order',
    'wrong_location',
    'too_long',
    'other',
  ];
  late String _reason = widget.initial?.reason ?? 'wrong_order';
  late final Set<String> _areas = {...?widget.initial?.areaIds};
  late final TextEditingController _comment = TextEditingController(
    text: widget.initial?.comment ?? '',
  );

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  String _label(AppLocalizations l10n, String reason) => switch (reason) {
    'wrong_order' => l10n.routeFeedbackWrongOrder,
    'wrong_location' => l10n.routeFeedbackWrongLocation,
    'too_long' => l10n.routeFeedbackTooLong,
    _ => l10n.routeFeedbackOther,
  };

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final areas = [
      for (final area in widget.run.areas)
        if (area.sequencePosition != null) area,
    ];
    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.md,
        right: AppSpacing.md,
        bottom: MediaQuery.viewInsetsOf(context).bottom + AppSpacing.md,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l10n.routeFeedbackWhy, style: theme.textTheme.titleMedium),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.xs,
              children: [
                for (final reason in _reasons)
                  ChoiceChip(
                    key: ValueKey('route-feedback-reason-$reason'),
                    label: Text(_label(l10n, reason)),
                    selected: _reason == reason,
                    onSelected: (_) => setState(() => _reason = reason),
                  ),
              ],
            ),
            if (_reason == 'wrong_location' && areas.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.md),
              Text(l10n.routeFeedbackWhichAreas, style: theme.textTheme.titleSmall),
              const SizedBox(height: AppSpacing.xs),
              Wrap(
                spacing: AppSpacing.sm,
                runSpacing: AppSpacing.xs,
                children: [
                  for (final area in areas)
                    FilterChip(
                      label: Text(area.areaName(widget.locale)),
                      selected: _areas.contains(area.areaId),
                      onSelected: (selected) => setState(
                        () => selected
                            ? _areas.add(area.areaId)
                            : _areas.remove(area.areaId),
                      ),
                    ),
                ],
              ),
            ],
            const SizedBox(height: AppSpacing.md),
            TextField(
              key: const ValueKey('route-feedback-comment'),
              controller: _comment,
              maxLength: 500,
              maxLines: 3,
              minLines: 1,
              decoration: InputDecoration(labelText: l10n.routeFeedbackComment),
            ),
            const SizedBox(height: AppSpacing.sm),
            FilledButton(
              key: const ValueKey('route-feedback-send'),
              onPressed: () {
                final comment = _comment.text.trim();
                Navigator.of(context).pop(
                  _DislikeAnswer(
                    reason: _reason,
                    comment: comment.isEmpty ? null : comment,
                    areaIds: _reason == 'wrong_location'
                        ? [
                            for (final area in areas)
                              if (_areas.contains(area.areaId)) area.areaId,
                          ]
                        : null,
                  ),
                );
              },
              child: Text(l10n.routeFeedbackSend),
            ),
          ],
        ),
      ),
    );
  }
}

final class _CurrentStopCard extends StatelessWidget {
  const _CurrentStopCard({
    required this.stop,
    required this.following,
    required this.locale,
    required this.actionsEnabled,
    required this.canMove,
    required this.onOpen,
    required this.onDetails,
    required this.onStatus,
    required this.onNext,
    required this.onPrevious,
  });

  final TripStop stop;
  final TripStop? following;
  final String locale;
  final bool actionsEnabled;
  final bool canMove;
  final Future<void> Function(Uri? uri) onOpen;
  final VoidCallback onDetails;
  final void Function(String status) onStatus;
  final VoidCallback onNext;
  final VoidCallback onPrevious;

  static const _tall = Size.fromHeight(48);

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
    final place = [
      area.areaName(locale),
      area.emirateName(locale),
    ].where((part) => part.isNotEmpty).join(' · ');
    return BluelineSectionCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l10n.routeCurrentStop, style: theme.textTheme.labelMedium),
          if (place.isNotEmpty) Text(place, style: theme.textTheme.titleMedium),
          const SizedBox(height: AppSpacing.xs),
          Text(order.label, style: theme.textTheme.titleLarge),
          if (order.customerName?.trim().isNotEmpty ?? false)
            Text(order.customerName!.trim()),
          if (address.trim().isNotEmpty) Text(address),
          if (order.amountDue case final amount?)
            Text(
              '${l10n.routeCollect}: AED $amount',
              style: theme.textTheme.titleSmall,
            ),
          const SizedBox(height: AppSpacing.sm),
          FilledButton.icon(
            style: FilledButton.styleFrom(minimumSize: _tall),
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
          const Divider(height: AppSpacing.lg),
          FilledButton.icon(
            key: const ValueKey('route-stop-delivered'),
            style: FilledButton.styleFrom(
              minimumSize: _tall,
              backgroundColor: AppColors.success,
              foregroundColor: Colors.white,
            ),
            onPressed: actionsEnabled ? () => onStatus('delivered') : null,
            icon: const Icon(Icons.check_circle_outline),
            label: Text(l10n.delivered),
          ),
          const SizedBox(height: AppSpacing.xs),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  key: const ValueKey('route-stop-hold'),
                  style: OutlinedButton.styleFrom(minimumSize: _tall),
                  onPressed: actionsEnabled ? () => onStatus('hold') : null,
                  icon: const Icon(Icons.pause_circle_outline),
                  label: Text(l10n.hold),
                ),
              ),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: OutlinedButton.icon(
                  key: const ValueKey('route-stop-return'),
                  style: OutlinedButton.styleFrom(minimumSize: _tall),
                  onPressed: actionsEnabled
                      ? () => onStatus('returned_to_branch')
                      : null,
                  icon: const Icon(Icons.undo),
                  label: Text(
                    l10n.returnToBranchAction,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          Row(
            children: [
              Expanded(
                child: FilledButton.tonalIcon(
                  key: const ValueKey('route-stop-previous'),
                  style: FilledButton.styleFrom(minimumSize: _tall),
                  onPressed: actionsEnabled && canMove ? onPrevious : null,
                  icon: const Icon(Icons.skip_previous_rounded),
                  label: Text(l10n.routePrevious),
                ),
              ),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: FilledButton.tonalIcon(
                  key: const ValueKey('route-stop-next'),
                  style: FilledButton.styleFrom(minimumSize: _tall),
                  onPressed: actionsEnabled && canMove ? onNext : null,
                  icon: const Icon(Icons.skip_next_rounded),
                  label: Text(l10n.routeNext),
                ),
              ),
            ],
          ),
          if (following case final then?)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(
                '${l10n.routeThen}: ${then.order.label}'
                '${then.area.areaName(locale).isEmpty ? '' : ' · ${then.area.areaName(locale)}'}',
                style: theme.textTheme.bodySmall,
              ),
            ),
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: TextButton.icon(
              onPressed: onDetails,
              icon: const Icon(Icons.description_outlined),
              label: Text(l10n.routeDetails),
            ),
          ),
        ],
      ),
    );
  }
}

/// One numbered stop in the route list. Tap the number to give it another
/// number; the arrows move it one place up or down.
final class _StopTile extends StatelessWidget {
  const _StopTile({
    required this.number,
    required this.stop,
    required this.isCurrent,
    required this.onNumber,
    required this.onUp,
    required this.onDown,
    required this.onTap,
  });

  final int number;
  final TripStop stop;
  final bool isCurrent;
  final VoidCallback? onNumber;
  final VoidCallback? onUp;
  final VoidCallback? onDown;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final order = stop.order;
    return ListTile(
      dense: true,
      selected: isCurrent,
      leading: InkWell(
        customBorder: const CircleBorder(),
        onTap: onNumber,
        child: Tooltip(
          message: l10n.routeChangeNumber,
          child: CircleAvatar(
            radius: 18,
            backgroundColor: isCurrent ? AppColors.primary : null,
            foregroundColor: isCurrent ? Colors.white : null,
            child: Text('$number'),
          ),
        ),
      ),
      title: Text(
        isCurrent ? '${order.label} · ${l10n.routeNow}' : order.label,
      ),
      subtitle: Text(
        [
          if (order.customerName?.trim().isNotEmpty ?? false)
            order.customerName!.trim(),
          if (order.amountDue case final amount?) 'AED $amount',
          if (order.noAnswerCount > 0)
            '${l10n.routeNoAnswerCount} ×${order.noAnswerCount}',
        ].join(' · '),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            tooltip: l10n.routeMoveUp,
            visualDensity: VisualDensity.compact,
            onPressed: onUp,
            icon: const Icon(Icons.arrow_upward, size: 18),
          ),
          IconButton(
            tooltip: l10n.routeMoveDown,
            visualDensity: VisualDensity.compact,
            onPressed: onDown,
            icon: const Icon(Icons.arrow_downward, size: 18),
          ),
        ],
      ),
      onTap: order.id.isEmpty ? null : onTap,
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
    this.onNumber,
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

  /// Tapping the number gives the Area a new place in the route.
  final VoidCallback? onNumber;

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
        // Open by default, so the Driver sees the Order sequence at once.
        initiallyExpanded: !area.isDone,
        leading: InkWell(
          customBorder: const CircleBorder(),
          onTap: onNumber,
          child: Tooltip(
            message: l10n.routeChangeNumber,
            child: CircleAvatar(
              backgroundColor: area.isDone
                  ? AppColors.success
                  : AppColors.primary,
              foregroundColor: Colors.white,
              child: area.isDone
                  ? const Icon(Icons.check, size: 18)
                  : Text('${index + 1}'),
            ),
          ),
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
  const _OrderTile({required this.order, this.trailing, this.onTap});
  final RouteOrder order;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return ListTile(
      dense: true,
      // The reference number is what the Driver and the trader quote, so it
      // leads; the customer name follows when there is one.
      title: Text(order.label),
      subtitle: Text(
        [
          if (order.customerName?.trim().isNotEmpty ?? false)
            order.customerName!.trim(),
          if (order.noAnswerCount > 0)
            '${l10n.routeNoAnswerCount} ×${order.noAnswerCount}',
        ].join(' · '),
      ),
      trailing: trailing,
      onTap: order.id.isEmpty ? null : onTap,
    );
  }
}
