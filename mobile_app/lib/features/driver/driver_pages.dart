import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:uuid/uuid.dart';

final class DriverOrdersPage extends ConsumerStatefulWidget {
  const DriverOrdersPage({super.key});
  @override
  ConsumerState<DriverOrdersPage> createState() => _DriverOrdersPageState();
}

final class _DriverOrdersPageState extends ConsumerState<DriverOrdersPage> {
  late Future<List<DriverOrder>> future;
  @override
  void initState() {
    super.initState();
    future = ref.read(driverRepositoryProvider).orders();
  }

  Future<void> refresh() async {
    final next = ref.read(driverRepositoryProvider).orders();
    setState(() => future = next);
    await next;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
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
          FutureBuilder<List<DriverOrder>>(
            future: future,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const DashboardSkeleton();
              }
              if (snapshot.hasError) {
                return AppErrorState(
                  message: l10n.dataUnavailable,
                  onRetry: refresh,
                );
              }
              final orders = snapshot.data ?? const [];
              if (orders.isEmpty) return AppEmptyState(message: l10n.noOrders);
              return Column(
                children: [
                  for (final order in orders) ...[
                    OrderCard(
                      order: OrderCardModel(
                        orderNumber: order.orderNumber,
                        externalReference: order.reference,
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
  @override
  void initState() {
    super.initState();
    future = _load();
  }

  Future<DriverOrder?> _load() async {
    final orders = await ref.read(driverRepositoryProvider).orders();
    for (final order in orders) {
      if (order.id == widget.orderId) return order;
    }
    return null;
  }

  Future<void> _reload() async {
    final next = _load();
    setState(() => future = next);
    await next;
  }

  Future<void> _start() async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(l10n.startDeliveryConfirm),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(l10n.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(l10n.startDelivery),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() => changing = true);
    try {
      await ref
          .read(driverRepositoryProvider)
          .startDelivery(widget.orderId, const Uuid().v4());
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.deliveryStarted)));
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

  Future<void> _open(Uri uri, String error) async {
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication) &&
        mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return FutureBuilder<DriverOrder?>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        final order = snapshot.data;
        if (snapshot.hasError || order == null) {
          return AppErrorState(message: l10n.dataUnavailable, onRetry: _reload);
        }
        final actions = actionsForDriverStatus(order.status);
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
                cod: order.expectedCod,
                status: order.status,
              ),
              audience: OrderAudience.driver,
            ),
            if (order.notes != null)
              ListTile(title: Text(l10n.notes), subtitle: Text(order.notes!)),
            ListTile(
              title: Text(l10n.expectedCod),
              subtitle: Text('AED ${order.expectedCod}'),
            ),
            Wrap(
              spacing: AppSpacing.sm,
              children: [
                OutlinedButton.icon(
                  onPressed: isSafeCustomerContact(order.customerMobile)
                      ? () => _open(
                          Uri(scheme: 'tel', path: order.customerMobile),
                          l10n.externalAppUnavailable,
                        )
                      : null,
                  icon: const Icon(Icons.call_outlined),
                  label: Text(l10n.callCustomer),
                ),
                OutlinedButton.icon(
                  onPressed: order.address.trim().isEmpty
                      ? null
                      : () => _open(
                          Uri.https('www.google.com', '/maps/search/', {
                            'api': '1',
                            'query': order.address,
                          }),
                          l10n.externalAppUnavailable,
                        ),
                  icon: const Icon(Icons.map_outlined),
                  label: Text(l10n.openMap),
                ),
                OutlinedButton.icon(
                  onPressed: null,
                  icon: const Icon(Icons.chat_outlined),
                  label: Text(l10n.messageOffice),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            if (actions.contains(DriverAction.startDelivery))
              FilledButton(
                onPressed: changing ? null : _start,
                child: Text(l10n.startDelivery),
              ),
            if (actions.contains(DriverAction.markDelivered))
              FilledButton(onPressed: null, child: Text(l10n.markDelivered)),
            if (actions.contains(DriverAction.reportFailure))
              FilledButton.tonal(
                onPressed: null,
                child: Text(l10n.reportFailure),
              ),
            if (actions.contains(DriverAction.markDelivered) ||
                actions.contains(DriverAction.reportFailure))
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.sm),
                child: Text(l10n.driverActionUnavailable),
              ),
          ],
        );
      },
    );
  }
}
