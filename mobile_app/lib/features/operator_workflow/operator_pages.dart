import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/configuration/app_environment.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_models.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

bool hasOperatorOrderAccess(Iterable<String> permissions) =>
    permissions.any(operatorOrderPermissions.contains);

final class OperatorOrdersPage extends ConsumerStatefulWidget {
  const OperatorOrdersPage({super.key});
  @override
  ConsumerState<OperatorOrdersPage> createState() => _OperatorOrdersPageState();
}

final class _OperatorOrdersPageState extends ConsumerState<OperatorOrdersPage> {
  List<OperatorOrder> items = [];
  int page = 1;
  bool loading = true, hasMore = false;
  Object? error;
  String search = '';
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
          .orders(page: page, search: search);
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
                    _devError(error!),
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

String _devError(Object error) {
  if (error is ApiFailure) {
    final status = error.statusCode == null
        ? ''
        : 'HTTP ${error.statusCode} — ';
    return 'DEV Orders: $status${error.code ?? error.kind.name.toUpperCase()}';
  }
  return 'DEV Orders: UNKNOWN_ERROR';
}

final class OperatorOrderDetailsPage extends ConsumerStatefulWidget {
  const OperatorOrderDetailsPage({required this.orderId, super.key});
  final String orderId;
  @override
  ConsumerState<OperatorOrderDetailsPage> createState() =>
      _OperatorOrderDetailsPageState();
}

final class _OperatorOrderDetailsPageState
    extends ConsumerState<OperatorOrderDetailsPage> {
  late Future<OperatorOrder> future;
  bool assigning = false;
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

  Future<void> assign() async {
    final l10n = AppLocalizations.of(context);
    List<OperatorDriver> drivers;
    try {
      drivers = (await ref.read(operatorRepositoryProvider).drivers())
          .where((d) => d.eligible)
          .toList();
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l10n.dataUnavailable)));
      }
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
        title: Text(l10n.assignmentConfirm),
        content: Text(selected.name),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(l10n.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(l10n.assignDriver),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => assigning = true);
    try {
      await ref
          .read(operatorRepositoryProvider)
          .assign(widget.orderId, selected.id);
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.assignmentCompleted)));
      await refresh();
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(l10n.dataUnavailable)));
      }
    } finally {
      if (mounted) {
        setState(() => assigning = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final user = ref.watch(authenticationProvider).value?.user;
    return FutureBuilder<OperatorOrder>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        final order = snapshot.data;
        if (snapshot.hasError || order == null) {
          return AppErrorState(message: l10n.dataUnavailable, onRetry: refresh);
        }
        final canAssign =
            user?.can('orders.assign_driver') == true &&
            order.driverId == null &&
            {'new', 'in_branch', 'hold'}.contains(order.status);
        return ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            OrderCard(
              order: OrderCardModel(
                orderNumber: order.orderNumber,
                externalReference: order.reference,
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
            if (canAssign)
              FilledButton(
                onPressed: assigning ? null : assign,
                child: Text(l10n.assignDriver),
              ),
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
            Text(l10n.operatorActionsUnavailable),
          ],
        );
      },
    );
  }
}
