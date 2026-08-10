import 'dart:async';

import 'package:bluelinegpt_mobile/app/configuration/app_environment.dart';
import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_order_detail_view.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart' as intl;
import 'package:url_launcher/url_launcher.dart';
import 'package:uuid/uuid.dart';

/// Result of a Driver Orders load — the list plus whether it came from the
/// network just now or from the offline cache (Prompt 16 §F), and the
/// latest sync-queue state per Order for the "Pending Sync"/"Syncing"/…
/// badge (§H/§X). `FakeDriverRepository`-backed tests (pre-Prompt 16) never
/// produce an offline-aware repository, so `freshness.isOffline` is always
/// `false` and `badges` always empty for them — the banner/badges simply
/// never render, and every existing assertion keeps holding.
final class _DriverOrdersLoad {
  const _DriverOrdersLoad({
    required this.orders,
    required this.freshness,
    required this.badges,
  });
  final List<DriverOrder> orders;
  final DriverDataFreshness freshness;
  final Map<String, DriverQueueEntry> badges;
}

Future<DriverDataFreshness> _ordersFreshness(WidgetRef ref) async {
  final repo = ref.read(driverRepositoryProvider);
  if (repo is OfflineAwareDriverRepository) return repo.ordersFreshness();
  return const DriverDataFreshness(isOffline: false);
}

Future<Map<String, DriverQueueEntry>> _orderBadges(WidgetRef ref) async {
  final repo = ref.read(driverRepositoryProvider);
  if (repo is OfflineAwareDriverRepository) {
    return repo.latestQueueEntriesByOrder();
  }
  return const {};
}

String _formatSyncTimestamp(DateTime value, String locale) =>
    intl.DateFormat('dd MMM yyyy, h:mm a', locale).format(value.toLocal());

final class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner({required this.lastSyncedAt});
  final DateTime? lastSyncedAt;
  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final synced = lastSyncedAt == null
        ? l10n.notAvailable
        : _formatSyncTimestamp(lastSyncedAt!, locale);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Row(
        children: [
          const Icon(
            Icons.cloud_off_outlined,
            size: 16,
            color: AppColors.warning,
          ),
          const SizedBox(width: AppSpacing.xs),
          Expanded(
            child: Text(
              '${l10n.driverOfflineBanner} — ${l10n.driverLastSyncedLabel}: $synced',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}

final class _DriverSyncBadge extends StatelessWidget {
  const _DriverSyncBadge({required this.state, this.onTap});
  final DriverSyncRowState state;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final (label, color) = switch (state) {
      DriverSyncRowState.pending => (l10n.driverSyncPending, AppColors.info),
      DriverSyncRowState.syncing => (l10n.driverSyncInProgress, AppColors.info),
      DriverSyncRowState.synced => (
        l10n.driverSyncCompleted,
        AppColors.success,
      ),
      DriverSyncRowState.failed => (l10n.driverSyncFailed, AppColors.error),
      DriverSyncRowState.conflict => (
        l10n.driverSyncNeedsReview,
        AppColors.warning,
      ),
    };
    return InkWell(
      onTap: onTap,
      child: Chip(
        visualDensity: VisualDensity.compact,
        avatar: Icon(Icons.sync, size: 14, color: color),
        label: Text(label),
      ),
    );
  }
}

final class DriverOrdersPage extends ConsumerStatefulWidget {
  const DriverOrdersPage({super.key, this.initialDeliveryStatus});

  /// Matches the `deliveryStatus` value encoded in a dashboard card's route
  /// (see `driverDashboardCards`), e.g. `out_for_delivery`. `null` (or the
  /// backend-unused `""`) means no filter — the full assigned Orders set.
  /// The Driver Orders endpoint has no server-side status filter (unlike
  /// Operator's), so this is applied client-side against the same list this
  /// page would otherwise show unfiltered — no new endpoint, no regression
  /// to the existing unfiltered list behavior. Continues to work identically
  /// against the offline-cached list (Prompt 16 §F) — the filter never
  /// special-cases where the data came from.
  final String? initialDeliveryStatus;
  @override
  ConsumerState<DriverOrdersPage> createState() => _DriverOrdersPageState();
}

final class _DriverOrdersPageState extends ConsumerState<DriverOrdersPage> {
  late Future<_DriverOrdersLoad> future;
  @override
  void initState() {
    super.initState();
    future = _load();
  }

  Future<_DriverOrdersLoad> _load() async {
    final orders = await ref.read(driverRepositoryProvider).orders();
    final freshness = await _ordersFreshness(ref);
    final badges = await _orderBadges(ref);
    return _DriverOrdersLoad(
      orders: orders,
      freshness: freshness,
      badges: badges,
    );
  }

  Future<void> refresh() async {
    final next = _load();
    // A block body, not `() => future = next` — that arrow form evaluates to
    // the assignment's value (`next`, a `Future`), which trips
    // `setState`'s "callback returned a Future" debug assertion the first
    // time this path is actually exercised (previously only reachable via a
    // manual pull-to-refresh gesture; the Prompt 15 orders-refresh signal
    // below is the first caller to invoke `refresh()` directly in a test).
    setState(() {
      future = next;
    });
    await next;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final statusFilter = widget.initialDeliveryStatus;
    // A foreground `order.*` push, or a completed offline sync pass (Prompt
    // 16 §L, which bumps this same signal), is only ever a "refresh from the
    // server" hint — this list re-fetches rather than trying to patch any
    // single Order in place.
    ref.listen(ordersRefreshSignalProvider, (_, _) => refresh());
    return RefreshIndicator(
      onRefresh: refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Text(
            l10n.driverOrdersLimited,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.md),
          FutureBuilder<_DriverOrdersLoad>(
            future: future,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const DashboardSkeleton();
              }
              if (snapshot.hasError) {
                final configuration = ref.watch(configurationProvider);
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    AppErrorState(
                      message: l10n.dataUnavailable,
                      onRetry: refresh,
                    ),
                    if (configuration.environment ==
                            AppEnvironment.development &&
                        snapshot.error != null)
                      Text(
                        devApiFailureText('Driver Orders', snapshot.error!),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                  ],
                );
              }
              final load = snapshot.data;
              final allOrders = load?.orders ?? const [];
              final orders = (statusFilter == null || statusFilter.isEmpty)
                  ? allOrders
                  : allOrders
                        .where((order) => order.status == statusFilter)
                        .toList();
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (load != null && load.freshness.isOffline)
                    _OfflineBanner(lastSyncedAt: load.freshness.lastSyncedAt),
                  if (orders.isEmpty)
                    AppEmptyState(message: l10n.noOrders)
                  else
                    for (final order in orders) ...[
                      OrderCard(
                        order: OrderCardModel(
                          orderNumber: order.orderNumber,
                          externalReference: order.reference,
                          serialNumber: order.serialNumber,
                          customerName: order.customerName,
                          mobileNumber: order.customerMobile,
                          area: order.areaName,
                          addressSummary: order.address,
                          cod: order.expectedCod,
                          status: order.status,
                        ),
                        audience: OrderAudience.driver,
                        onTap: () => context.push('/orders/${order.id}'),
                      ),
                      if (load?.badges[order.id] case final entry?) ...[
                        const SizedBox(height: AppSpacing.xs),
                        _DriverSyncBadge(state: entry.state),
                      ],
                      const SizedBox(height: AppSpacing.sm),
                    ],
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}

final class DriverOrderDetailsPage extends ConsumerStatefulWidget {
  const DriverOrderDetailsPage({required this.orderId, super.key});
  final String orderId;
  @override
  ConsumerState<DriverOrderDetailsPage> createState() =>
      _DriverOrderDetailsPageState();
}

final class _DriverOrderDetailsPageState
    extends ConsumerState<DriverOrderDetailsPage> {
  late Future<DriverOrder?> future;
  bool changing = false;
  // Fetched only the first time the Order History section is expanded, then
  // cached for the life of this page — a later collapse/expand must not
  // trigger a second `history()` call.
  Future<List<DriverOrderHistoryEvent>>? historyFuture;
  DriverQueueEntry? _pendingHistoryEntry;

  // The most recently loaded Order — used as `expectedStatus` for the next
  // status-change attempt (Prompt 16 §E: "the caller should pass the cached
  // current status as expectedStatus") and to read the current sync badge.
  DriverOrder? _lastLoadedOrder;
  DriverDataFreshness _freshness = const DriverDataFreshness(isOffline: false);
  DriverQueueEntry? _syncEntry;

  // The Order object returned directly by the most recent successful
  // `changeStatus()` call. `GET portal/driver/orders` (what `_load()`
  // otherwise searches) deliberately excludes `hold` from its status filter
  // — an Order a Driver just placed on Hold intentionally drops off that
  // list — so a plain re-fetch-and-search after a successful Hold would
  // find nothing and incorrectly show "Data is currently unavailable"
  // immediately after a successful action. The PATCH response already
  // carries the authoritative post-change Order regardless of status, so
  // `_load()` falls back to this instead of surfacing a false error.
  DriverOrder? _lastChangedOrder;

  @override
  void initState() {
    super.initState();
    future = _load();
  }

  Future<DriverOrder?> _load() async {
    final orders = await ref.read(driverRepositoryProvider).orders();
    _freshness = await _ordersFreshness(ref);
    final repo = ref.read(driverRepositoryProvider);
    if (repo is OfflineAwareDriverRepository) {
      final entries = await repo.queueEntriesForOrder(widget.orderId);
      _syncEntry = entries.isEmpty ? null : entries.last;
    } else {
      _syncEntry = null;
    }
    for (final order in orders) {
      if (order.id == widget.orderId) {
        _lastLoadedOrder = order;
        // The list has caught up (or never disagreed) — the fallback is
        // only ever needed for the one refresh right after an action moved
        // this Order out of the list's status filter.
        _lastChangedOrder = null;
        return order;
      }
    }
    final fallback = _lastChangedOrder;
    if (fallback != null && fallback.id == widget.orderId) {
      _lastLoadedOrder = fallback;
      return fallback;
    }
    _lastLoadedOrder = null;
    return null;
  }

  Future<void> _reload() async {
    final next = _load();
    // A block body, not `() => future = next` — see the identical note on
    // `DriverOrdersPage.refresh()`: that arrow form evaluates to the
    // assignment's value (a `Future`), which trips `setState`'s "callback
    // returned a Future" debug assertion.
    setState(() {
      future = next;
    });
    await next;
  }

  void _onHistoryExpansionChanged(bool expanded) {
    if (expanded && historyFuture == null) {
      setState(() {
        historyFuture = ref
            .read(driverRepositoryProvider)
            .history(widget.orderId);
      });
      unawaited(_loadPendingHistoryEntry());
    }
  }

  Future<void> _loadPendingHistoryEntry() async {
    final repo = ref.read(driverRepositoryProvider);
    if (repo is! OfflineAwareDriverRepository) return;
    final entries = await repo.queueEntriesForOrder(widget.orderId);
    final relevant = [
      for (final entry in entries)
        if (entry.state == DriverSyncRowState.pending ||
            entry.state == DriverSyncRowState.syncing ||
            entry.state == DriverSyncRowState.synced)
          entry,
    ];
    if (relevant.isNotEmpty && mounted) {
      setState(() => _pendingHistoryEntry = relevant.last);
    }
  }

  Future<void> _open(Uri uri, String error) async {
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication) &&
        mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  /// Shared status-change flow for every Driver action — a plain confirm
  /// dialog for transitions that need no reason, or a reason-required
  /// `TextField` dialog (mirroring `operator_pages.dart`'s `changeStatus`
  /// pattern) for `returned_to_branch`. A fresh idempotency key is generated
  /// per attempt, never reused across separate actions. The offline-aware
  /// repository never throws for a genuinely-unreachable network — it
  /// durably queues the action and returns the optimistically-updated Order
  /// instead (Prompt 16 §H), so this flow shows the same success message and
  /// refreshes exactly as an online change would.
  Future<void> _changeStatus({
    required String target,
    required String confirmTitle,
    required String confirmButtonLabel,
    required String successMessage,
    bool reasonRequired = false,
  }) async {
    final l10n = AppLocalizations.of(context);
    String? reason;
    if (reasonRequired) {
      reason = await promptDriverStatusReason(
        context,
        title: confirmTitle,
        confirmLabel: confirmButtonLabel,
      );
      if (reason == null || reason.trim().isEmpty || !mounted) return;
    } else {
      final confirmed = await promptDriverStatusConfirm(
        context,
        title: confirmTitle,
        confirmLabel: confirmButtonLabel,
      );
      if (!confirmed || !mounted) return;
    }
    setState(() => changing = true);
    try {
      final updated = await ref
          .read(driverRepositoryProvider)
          .changeStatus(
            widget.orderId,
            target,
            const Uuid().v4(),
            reason: reason,
            expectedStatus: _lastLoadedOrder?.status,
          );
      if (!mounted) return;
      // Kept as a fallback for `_load()` — the Orders list this page's own
      // reload re-fetches from can deliberately exclude the status this
      // action just landed on (Hold), and this is the only place that knows
      // the freshest post-change truth regardless.
      _lastChangedOrder = updated;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(successMessage)));
      await _reload();
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l10n.dataUnavailable)));
      }
    } finally {
      if (mounted) {
        setState(() => changing = false);
      }
    }
  }

  Future<void> _start() {
    final l10n = AppLocalizations.of(context);
    return _changeStatus(
      target: 'out_for_delivery',
      confirmTitle: l10n.startDeliveryConfirm,
      confirmButtonLabel: l10n.startDelivery,
      successMessage: l10n.deliveryStarted,
    );
  }

  Future<void> _markDelivered() {
    final l10n = AppLocalizations.of(context);
    return _changeStatus(
      target: 'delivered',
      confirmTitle: l10n.confirmStatusChange,
      confirmButtonLabel: l10n.delivered,
      successMessage: l10n.statusUpdateCompleted,
    );
  }

  Future<void> _hold() {
    final l10n = AppLocalizations.of(context);
    return _changeStatus(
      target: 'hold',
      confirmTitle: l10n.confirmStatusChange,
      confirmButtonLabel: l10n.hold,
      successMessage: l10n.orderPlacedOnHold,
      reasonRequired: true,
    );
  }

  Future<void> _returnToBranch() {
    final l10n = AppLocalizations.of(context);
    return _changeStatus(
      target: 'returned_to_branch',
      confirmTitle: l10n.confirmStatusChange,
      confirmButtonLabel: l10n.returnToBranchAction,
      successMessage: l10n.statusUpdateCompleted,
      reasonRequired: true,
    );
  }

  void _onDriverAction(DriverAction action) {
    switch (action) {
      case DriverAction.startDelivery:
        _start();
      case DriverAction.markDelivered:
        _markDelivered();
      case DriverAction.hold:
        _hold();
      case DriverAction.returnToBranch:
        _returnToBranch();
    }
  }

  Future<void> _retrySyncEntry(DriverQueueEntry entry) async {
    final repo = ref.read(driverRepositoryProvider);
    if (repo is! OfflineAwareDriverRepository) return;
    await repo.retryFailedEntry(
      entry: entry,
      newLocalActionId: const Uuid().v4(),
    );
    await _reload();
  }

  Future<void> _resolveConflict(DriverQueueEntry entry) async {
    final l10n = AppLocalizations.of(context);
    final refresh = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(l10n.driverSyncNeedsReview),
        content: Text(l10n.driverConflictMessage),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(l10n.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(l10n.driverRefreshAction),
          ),
        ],
      ),
    );
    if (refresh != true) return;
    final repo = ref.read(driverRepositoryProvider);
    if (repo is OfflineAwareDriverRepository) {
      await repo.refreshAfterConflict(widget.orderId);
    }
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    return FutureBuilder<DriverOrder?>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        final order = snapshot.data;
        if (snapshot.hasError || order == null) {
          final configuration = ref.watch(configurationProvider);
          return Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                AppErrorState(message: l10n.dataUnavailable, onRetry: _reload),
                if (configuration.environment == AppEnvironment.development &&
                    snapshot.error != null)
                  Text(
                    devApiFailureText('Driver Order Detail', snapshot.error!),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
              ],
            ),
          );
        }
        final actions = actionsForDriverStatus(order.status);
        final emirateName = locale == 'ar'
            ? (order.emirateNameAr ?? order.emirateNameEn)
            : (order.emirateNameEn ?? order.emirateNameAr);
        final syncEntry = _syncEntry;
        return ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            if (_freshness.isOffline)
              _OfflineBanner(lastSyncedAt: _freshness.lastSyncedAt),
            if (syncEntry != null)
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                child: _DriverSyncBadge(
                  state: syncEntry.state,
                  onTap: syncEntry.state == DriverSyncRowState.conflict
                      ? () => _resolveConflict(syncEntry)
                      : null,
                ),
              ),
            if (syncEntry?.state == DriverSyncRowState.failed)
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton(
                  onPressed: () => _retrySyncEntry(syncEntry!),
                  child: Text(l10n.retry),
                ),
              ),
            DriverStyleOrderFields(
              order: DriverStyleOrderData(
                serialNumber: order.serialNumber,
                orderDate: order.orderDate,
                customerName: order.customerName,
                customerMobile: order.customerMobile,
                areaName: order.areaName,
                address: order.address,
                cod: order.expectedCod,
                status: order.status,
                traderName: order.traderName,
                reference: order.reference,
                notes: order.notes,
                emirateName: emirateName,
              ),
              locale: locale,
              onOpenUri: (uri, error) => _open(uri, error),
            ),
            if (actions.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.sm),
              DriverStatusActionsCard(
                actions: actions,
                busy: changing,
                onAction: _onDriverAction,
              ),
            ],
            const SizedBox(height: AppSpacing.sm),
            Card(
              child: ExpansionTile(
                title: Text(l10n.orderHistory),
                onExpansionChanged: _onHistoryExpansionChanged,
                children: [
                  if (historyFuture != null)
                    FutureBuilder<List<DriverOrderHistoryEvent>>(
                      future: historyFuture,
                      builder: (context, historySnapshot) {
                        if (historySnapshot.connectionState ==
                            ConnectionState.waiting) {
                          return const Padding(
                            padding: EdgeInsets.all(AppSpacing.md),
                            child: Center(
                              child: SizedBox.square(
                                dimension: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              ),
                            ),
                          );
                        }
                        if (historySnapshot.hasError) {
                          return AppErrorState(message: l10n.dataUnavailable);
                        }
                        final events = historySnapshot.data ?? const [];
                        final pending = _pendingHistoryEntry;
                        // Only shown while the confirmed server History for
                        // this exact transition has not yet superseded it
                        // (Prompt 16 §Z) — never duplicated once it has.
                        final showPendingRow =
                            pending != null &&
                            !events.any(
                              (event) =>
                                  event.toStatus == pending.targetStatus &&
                                  event.fromStatus == pending.expectedStatus,
                            );
                        if (events.isEmpty && !showPendingRow) {
                          return AppEmptyState(message: l10n.dataUnavailable);
                        }
                        return Column(
                          children: [
                            if (showPendingRow)
                              ListTile(
                                leading: const Icon(
                                  Icons.sync,
                                  color: AppColors.info,
                                ),
                                title: Text(
                                  driverHistoryTransitionLabel(
                                    DriverOrderHistoryEvent(
                                      fromStatus: pending.expectedStatus,
                                      toStatus: pending.targetStatus,
                                      occurredAt: pending.createdAt
                                          .toIso8601String(),
                                    ),
                                    l10n,
                                  ),
                                ),
                                subtitle: Text(l10n.driverSyncPending),
                              ),
                            for (final event in events)
                              ListTile(
                                leading: const Icon(Icons.history),
                                title: Text(
                                  driverHistoryTransitionLabel(event, l10n),
                                ),
                                subtitle: Text(
                                  formatDriverHistoryTimestamp(
                                    event.occurredAt,
                                    locale,
                                  ),
                                ),
                              ),
                          ],
                        );
                      },
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}
