import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/configuration/app_environment.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_order_detail_view.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_models.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

bool hasOperatorOrderAccess(Iterable<String> permissions) =>
    permissions.any(operatorOrderPermissions.contains);

final class OperatorOrdersPage extends ConsumerStatefulWidget {
  const OperatorOrdersPage({super.key, this.initialDeliveryStatus});
  final String? initialDeliveryStatus;
  @override
  ConsumerState<OperatorOrdersPage> createState() => _OperatorOrdersPageState();
}

/// The 7 approved user-facing statuses, mapped to the exact backend value the
/// `deliveryStatus` query parameter expects. `null` means "no status filter"
/// (all Active statuses, the server default).
const Map<String?, String> operatorStatusFilterOptions = {
  null: '',
  'new': 'new',
  'assigned_to_driver': 'assigned_to_driver',
  'out_for_delivery': 'out_for_delivery',
  'delivered': 'delivered',
  'returned_to_branch': 'returned_to_branch',
  'returned_to_trader': 'returned_to_trader',
  'cancelled': 'cancelled',
};

final class _OperatorOrdersPageState extends ConsumerState<OperatorOrdersPage> {
  List<OperatorOrder> items = [];
  int page = 1;
  bool loading = true, hasMore = false;
  Object? error;
  String search = '';
  late String? statusFilter = widget.initialDeliveryStatus;
  @override
  void initState() {
    super.initState();
    _load(refresh: true);
  }

  Future<void> _load({bool refresh = false}) async {
    if (refresh) page = 1;
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final result = await ref
          .read(operatorRepositoryProvider)
          .orders(page: page, search: search, status: statusFilter);
      if (!mounted) return;
      final existing = refresh ? <String>{} : items.map((e) => e.id).toSet();
      setState(() {
        items = [
          if (!refresh) ...items,
          ...result.items.where((e) => existing.add(e.id)),
        ];
        hasMore = result.hasMore;
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

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final configuration = ref.watch(configurationProvider);
    return RefreshIndicator(
      onRefresh: () => _load(refresh: true),
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          AppSearchField(
            onChanged: (value) {
              search = value;
              _load(refresh: true);
            },
            loading: loading,
          ),
          const SizedBox(height: AppSpacing.sm),
          _StatusFilterRow(
            selected: statusFilter,
            onChanged: (value) {
              setState(() => statusFilter = value);
              _load(refresh: true);
            },
          ),
          const SizedBox(height: AppSpacing.md),
          if (error != null)
            Column(
              children: [
                AppErrorState(
                  message: l10n.dataUnavailable,
                  onRetry: () => _load(refresh: true),
                ),
                if (configuration.environment == AppEnvironment.development)
                  Text(
                    devApiFailureText('Orders', error!),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
              ],
            )
          else if (loading && items.isEmpty)
            const DashboardSkeleton()
          else if (items.isEmpty)
            AppEmptyState(message: l10n.noOrders)
          else ...[
            for (final order in items) ...[
              OrderCard(
                order: OrderCardModel(
                  orderNumber: order.orderNumber,
                  externalReference: order.reference,
                  serialNumber: order.serialNumber,
                  customerName: order.customerName,
                  mobileNumber: order.customerMobile,
                  area: order.areaName,
                  addressSummary: order.address,
                  cod: order.cod,
                  assignedDriverName: order.driverName,
                  status: order.status,
                ),
                audience: OrderAudience.operatorRole,
                onTap: () => context.push('/orders/${order.id}'),
              ),
              const SizedBox(height: AppSpacing.sm),
            ],
            if (hasMore)
              OutlinedButton(
                onPressed: loading
                    ? null
                    : () {
                        page += 1;
                        _load();
                      },
                child: Text(l10n.loadMore),
              ),
          ],
        ],
      ),
    );
  }
}

/// Single-select status filter — the backend's `deliveryStatus` query
/// parameter accepts exactly one value, so the UI never offers a multi-select
/// that would silently drop all but one of the Operator's choices.
final class _StatusFilterRow extends StatelessWidget {
  const _StatusFilterRow({required this.selected, required this.onChanged});
  final String? selected;
  final ValueChanged<String?> onChanged;
  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final options = <String?, String>{
      null: l10n.allActive,
      'new': l10n.newStatus,
      'assigned_to_driver': l10n.assignedToDriver,
      'out_for_delivery': l10n.outForDelivery,
      'delivered': l10n.delivered,
      'returned_to_branch': l10n.returnedToBranch,
      'returned_to_trader': l10n.returnedToTrader,
      'cancelled': l10n.cancelled,
    };
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final option in options.entries) ...[
            ChoiceChip(
              label: Text(option.value),
              selected: selected == option.key,
              onSelected: (_) => onChanged(option.key),
            ),
            const SizedBox(width: AppSpacing.xs),
          ],
        ],
      ),
    );
  }
}

final class OperatorOrderDetailsPage extends ConsumerStatefulWidget {
  const OperatorOrderDetailsPage({
    required this.orderId,
    super.key,
    this.driverPresentation = false,
  });
  final String orderId;

  /// True only for a Driver User (`company_user` + resolved
  /// `linkedDriverId`, see `AuthenticatedUser.isDriverPresentation`) —
  /// renders the same Driver field layout/collapsed-History/status-action
  /// experience as `DriverOrderDetailsPage`, but still sources data and
  /// actions from the Operator repository/endpoints, since a Driver User
  /// (`company_user`) would get a 403 from the driver-portal routes. Assign/
  /// Reassign Driver controls are never shown in this mode — presentation
  /// matches a genuine Driver, which never has them either.
  final bool driverPresentation;
  @override
  ConsumerState<OperatorOrderDetailsPage> createState() =>
      _OperatorOrderDetailsPageState();
}

final class _OperatorOrderDetailsPageState
    extends ConsumerState<OperatorOrderDetailsPage> {
  late Future<OperatorOrder> future;
  bool actionInProgress = false;
  @override
  void initState() {
    super.initState();
    future = ref.read(operatorRepositoryProvider).detail(widget.orderId);
  }

  Future<void> refresh() async {
    final next = ref.read(operatorRepositoryProvider).detail(widget.orderId);
    setState(() => future = next);
    await next;
  }

  void _showFailure(Object error) {
    if (!mounted) return;
    final l10n = AppLocalizations.of(context);
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(l10n.dataUnavailable)));
  }

  /// Handles both a fresh assignment and a reassignment — the backend now
  /// accepts either through the same `bulk-assign` call, so this is one flow
  /// distinguished only by which confirmation copy and success message apply.
  Future<void> assignDriver({required bool reassigning}) async {
    final l10n = AppLocalizations.of(context);
    List<OperatorDriver> drivers;
    try {
      drivers = (await ref.read(operatorRepositoryProvider).drivers())
          .where((d) => d.eligible)
          .toList();
    } on Object catch (error) {
      _showFailure(error);
      return;
    }
    if (!mounted) return;
    final selected = await showDialog<OperatorDriver>(
      context: context,
      builder: (dialogContext) => SimpleDialog(
        title: Text(l10n.selectDriver),
        children: [
          for (final driver in drivers)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(dialogContext, driver),
              child: ListTile(
                title: Text(driver.name),
                subtitle: Text('${driver.type} • ${driver.activeOrders}'),
              ),
            ),
        ],
      ),
    );
    if (selected == null || !mounted) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(
          reassigning ? l10n.reassignmentConfirm : l10n.assignmentConfirm,
        ),
        content: Text(selected.name),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(l10n.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(reassigning ? l10n.reassignDriver : l10n.assignDriver),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => actionInProgress = true);
    try {
      await ref
          .read(operatorRepositoryProvider)
          .assign(widget.orderId, selected.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            reassigning ? l10n.reassignmentCompleted : l10n.assignmentCompleted,
          ),
        ),
      );
      await refresh();
    } on Object catch (error) {
      _showFailure(error);
    } finally {
      if (mounted) setState(() => actionInProgress = false);
    }
  }

  /// Only ever called with a target already produced by
  /// `operatorSelectableStatusTargets(order.status)` — the backend
  /// independently re-validates the transition regardless.
  Future<void> changeStatus(String target) async {
    final l10n = AppLocalizations.of(context);
    String? reason;
    if (operatorStatusChangeReasonRequired.contains(target)) {
      reason = await showDialog<String>(
        context: context,
        builder: (dialogContext) {
          final controller = TextEditingController();
          return AlertDialog(
            title: Text(l10n.confirmStatusChange),
            content: TextField(
              controller: controller,
              autofocus: true,
              maxLength: 300,
              decoration: InputDecoration(labelText: l10n.reasonLabel),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: Text(l10n.cancel),
              ),
              FilledButton(
                onPressed: controller.text.trim().isEmpty
                    ? null
                    : () =>
                          Navigator.pop(dialogContext, controller.text.trim()),
                child: Text(l10n.changeStatusAction),
              ),
            ],
          );
        },
      );
      if (reason == null || reason.trim().isEmpty || !mounted) return;
    } else {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(l10n.confirmStatusChange),
          content: StatusChip(status: target),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: Text(l10n.cancel),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(l10n.changeStatusAction),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
    setState(() => actionInProgress = true);
    try {
      await ref
          .read(operatorRepositoryProvider)
          .changeStatus(widget.orderId, target, reason: reason);
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.statusUpdateCompleted)));
      await refresh();
    } on Object catch (error) {
      _showFailure(error);
    } finally {
      if (mounted) setState(() => actionInProgress = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final user = ref.watch(authenticationProvider).value?.user;
    final configuration = ref.watch(configurationProvider);
    return FutureBuilder<OperatorOrder>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        final order = snapshot.data;
        if (snapshot.hasError || order == null) {
          return Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                AppErrorState(message: l10n.dataUnavailable, onRetry: refresh),
                if (configuration.environment == AppEnvironment.development &&
                    snapshot.error != null)
                  Text(
                    devApiFailureText('Order Detail', snapshot.error!),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
              ],
            ),
          );
        }
        final canChangeStatus =
            user?.can('orders.update_delivery_status') == true;
        final statusTargets = canChangeStatus
            ? operatorSelectableStatusTargets(order.status)
            : const <String>[];
        // Driver-presentation status actions never reuse the Operator's own
        // (broader) `statusTargets`/`canChangeStatus` above — a Driver User
        // gets exactly the same reachable-action set a genuine Driver would
        // for this status, sourced from the identical `actionsForDriverStatus`
        // truth table, never an invented third definition. Deliberately NOT
        // gated on `orders.update_delivery_status`: the backend authorizes a
        // Driver User to change status on their OWN Order via ownership
        // (`currentEmployeeDriverId`) alone, with no permission requirement —
        // exactly like a genuine `driver`-kind identity needs none. Ownership
        // is already guaranteed here: `order` only ever loaded in the first
        // place because the Operator `orderDetail()` endpoint itself
        // 404s a Driver User out of any Order that isn't their own, so no
        // separate re-check is needed before showing these buttons.
        final driverActions = widget.driverPresentation
            ? actionsForDriverStatus(order.status)
            : const <DriverAction>{};
        // Assign/Reassign Driver is never offered in driver-presentation
        // mode — a Driver User's Order Detail presents exactly like a
        // genuine Driver's (which never has these controls either), even
        // though the underlying `company_user` may hold
        // `orders.assign_driver`.
        final canAssignDriver =
            !widget.driverPresentation &&
            user?.can('orders.assign_driver') == true &&
            operatorCanAssignDriver(order.status, order.driverId);
        final canReassignDriver =
            !widget.driverPresentation &&
            user?.can('orders.assign_driver') == true &&
            operatorCanReassignDriver(order.status, order.driverId);
        if (widget.driverPresentation) {
          return _driverPresentationBody(
            context,
            l10n,
            order,
            driverActions: driverActions,
          );
        }
        final hasActions =
            canAssignDriver || canReassignDriver || statusTargets.isNotEmpty;
        return ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            OrderCard(
              order: OrderCardModel(
                orderNumber: order.orderNumber,
                externalReference: order.reference,
                serialNumber: order.serialNumber,
                customerName: order.customerName,
                mobileNumber: order.customerMobile,
                area: order.areaName,
                addressSummary: order.address,
                cod: order.cod,
                assignedDriverName: order.driverName,
                status: order.status,
              ),
              audience: OrderAudience.operatorRole,
            ),
            ListTile(
              title: Text(l10n.traderLabel),
              subtitle: Text(order.traderName),
            ),
            ListTile(
              title: Text(l10n.assignedDriverLabel),
              subtitle: Text(order.driverName ?? l10n.notAvailable),
            ),
            if (order.notes != null)
              ListTile(title: Text(l10n.notes), subtitle: Text(order.notes!)),
            if (hasActions) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(
                l10n.orderActions,
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: AppSpacing.sm),
              Wrap(
                spacing: AppSpacing.sm,
                runSpacing: AppSpacing.sm,
                children: [
                  if (canAssignDriver)
                    FilledButton(
                      onPressed: actionInProgress
                          ? null
                          : () => assignDriver(reassigning: false),
                      child: Text(l10n.assignDriver),
                    ),
                  if (canReassignDriver)
                    OutlinedButton(
                      onPressed: actionInProgress
                          ? null
                          : () => assignDriver(reassigning: true),
                      child: Text(l10n.reassignDriver),
                    ),
                  for (final target in statusTargets)
                    OutlinedButton(
                      onPressed: actionInProgress
                          ? null
                          : () => changeStatus(target),
                      child: Text(
                        OrderStatusMapper.label(
                          OrderStatusMapper.parse(target),
                          l10n,
                        ),
                      ),
                    ),
                ],
              ),
            ],
            const SizedBox(height: AppSpacing.md),
            Text(
              l10n.orderHistory,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            if (order.history.isEmpty)
              AppEmptyState(message: l10n.dataUnavailable)
            else
              for (final event in order.history)
                ListTile(
                  leading: const Icon(Icons.history),
                  title: StatusChip(status: event.status),
                  subtitle: Text(
                    [
                      event.occurredAt,
                      event.reason,
                    ].whereType<String>().join(' • '),
                  ),
                ),
          ],
        );
      },
    );
  }

  /// The shared Driver field layout (`DriverStyleOrderFields`) sourced from
  /// the Operator repository's `OperatorOrder` — used only for a Driver
  /// User. History is already present eagerly in `order.history` (the same
  /// `detail()` response), so it is shown collapsed with its count known
  /// immediately, never a second network call. Status actions reuse the
  /// shared `DriverStatusActionsCard` widget and exactly `driverActions`
  /// (`actionsForDriverStatus`) — the same Driver-scoped transitions a
  /// genuine Driver sees for this status, never the Operator's own broader
  /// `operatorSelectableStatusTargets`.
  Widget _driverPresentationBody(
    BuildContext context,
    AppLocalizations l10n,
    OperatorOrder order, {
    required Set<DriverAction> driverActions,
  }) {
    final locale = Localizations.localeOf(context).languageCode;
    final emirateName = locale == 'ar'
        ? (order.emirateNameAr ?? order.emirateNameEn)
        : (order.emirateNameEn ?? order.emirateNameAr);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        DriverStyleOrderFields(
          order: DriverStyleOrderData(
            serialNumber: order.serialNumber,
            orderDate: order.orderDate,
            customerName: order.customerName,
            customerMobile: order.customerMobile,
            areaName: order.areaName,
            address: order.address,
            cod: order.cod,
            status: order.status,
            traderName: order.traderName,
            reference: order.reference,
            notes: order.notes,
            emirateName: emirateName,
          ),
          locale: locale,
          onOpenUri: (uri, error) => _open(uri, error),
        ),
        if (driverActions.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.sm),
          DriverStatusActionsCard(
            actions: driverActions,
            busy: actionInProgress,
            onAction: _onDriverAction,
          ),
        ],
        const SizedBox(height: AppSpacing.sm),
        DriverOrderHistorySection(
          events: [
            for (final event in order.history)
              DriverOrderHistoryEvent(
                toStatus: event.status,
                occurredAt: event.occurredAt,
                fromStatus: event.fromStatus,
              ),
          ],
        ),
      ],
    );
  }

  /// The Driver-scoped status-change flow for driver-presentation mode —
  /// mirrors `DriverOrderDetailsPage._changeStatus` (genuine Driver) exactly
  /// (same shared `promptDriverStatusReason`/`promptDriverStatusConfirm`
  /// dialogs, same reason-required rule via `driverActionRequiresReason`),
  /// but calls the Operator's `changeStatus` endpoint — a `company_user`
  /// identity cannot call `/portal/driver/*`.
  Future<void> _onDriverAction(DriverAction action) async {
    final l10n = AppLocalizations.of(context);
    final target = driverActionTargetStatus(action);
    final label = driverActionLabel(action, l10n);
    String? reason;
    if (driverActionRequiresReason(action)) {
      reason = await promptDriverStatusReason(
        context,
        title: l10n.confirmStatusChange,
        confirmLabel: label,
      );
      if (reason == null || reason.trim().isEmpty || !mounted) return;
    } else {
      final confirmed = await promptDriverStatusConfirm(
        context,
        title: l10n.confirmStatusChange,
        confirmLabel: label,
      );
      if (!confirmed || !mounted) return;
    }
    setState(() => actionInProgress = true);
    try {
      await ref
          .read(operatorRepositoryProvider)
          .changeStatus(widget.orderId, target, reason: reason);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(driverActionSuccessMessage(action, l10n))),
      );
      await refresh();
    } on Object catch (error) {
      _showFailure(error);
    } finally {
      if (mounted) setState(() => actionInProgress = false);
    }
  }

  Future<void> _open(Uri uri, String errorMessage) async {
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication) &&
        mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(errorMessage)));
    }
  }
}
