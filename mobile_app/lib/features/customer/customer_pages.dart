import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/features/customer/customer_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

String customerStatusLabel(CustomerOrderStatus status, AppLocalizations l10n) =>
    switch (status) {
      CustomerOrderStatus.received => l10n.orderReceived,
      CustomerOrderStatus.assigned => l10n.assignedForDelivery,
      CustomerOrderStatus.outForDelivery => l10n.outForDelivery,
      CustomerOrderStatus.delivered => l10n.delivered,
      CustomerOrderStatus.deliveryIssue => l10n.deliveryIssue,
      CustomerOrderStatus.returnedToBranch => l10n.returnedToBranch,
      CustomerOrderStatus.returnedToTrader => l10n.returnedToTrader,
      CustomerOrderStatus.cancelled => l10n.cancelled,
      CustomerOrderStatus.updating => l10n.statusUpdating,
    };

final class CustomerAccountUnavailablePage extends StatelessWidget {
  const CustomerAccountUnavailablePage({super.key});
  @override
  Widget build(BuildContext context) => AppErrorState(
    message: AppLocalizations.of(context).customerAccessUnavailable,
  );
}

final class CustomerTrackingPage extends ConsumerStatefulWidget {
  const CustomerTrackingPage({required this.token, super.key});
  final String token;
  @override
  ConsumerState<CustomerTrackingPage> createState() =>
      _CustomerTrackingPageState();
}

final class _CustomerTrackingPageState
    extends ConsumerState<CustomerTrackingPage> {
  late Future<CustomerTrackingSummary> future;
  @override
  void initState() {
    super.initState();
    future = ref.read(customerRepositoryProvider).tracking(widget.token);
  }

  Future<void> refresh() async {
    final next = ref.read(customerRepositoryProvider).tracking(widget.token);
    setState(() => future = next);
    await next;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.trackOrder)),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            FutureBuilder<CustomerTrackingSummary>(
              future: future,
              builder: (context, snapshot) {
                if (snapshot.connectionState == ConnectionState.waiting) {
                  return const DashboardSkeleton();
                }
                final tracking = snapshot.data;
                if (snapshot.hasError || tracking == null) {
                  return AppErrorState(
                    message: l10n.trackingLinkExpired,
                    onRetry: refresh,
                  );
                }
                final status = customerStatusLabel(tracking.status, l10n);
                return Semantics(
                  label: '${tracking.orderNumber}, $status',
                  child: Card(
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.lg),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            tracking.companyName,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          const SizedBox(height: AppSpacing.sm),
                          Directionality(
                            textDirection: TextDirection.ltr,
                            child: Text(
                              tracking.orderNumber,
                              style: Theme.of(context).textTheme.headlineSmall,
                            ),
                          ),
                          const SizedBox(height: AppSpacing.sm),
                          Text(
                            status,
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          Text(tracking.areaName),
                          Text(
                            '${l10n.lastUpdatedLabel}: ${tracking.lastUpdatedAt}',
                          ),
                          if (tracking.deliveredAt != null)
                            Text(
                              '${l10n.deliveredAtLabel}: ${tracking.deliveredAt}',
                            ),
                          const SizedBox(height: AppSpacing.md),
                          OutlinedButton.icon(
                            onPressed: null,
                            icon: const Icon(Icons.support_agent),
                            label: Text(l10n.messageOffice),
                          ),
                          Text(
                            l10n.officeSupportUnavailable,
                            textAlign: TextAlign.center,
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              l10n.customerPrivacyNotice,
              style: Theme.of(context).textTheme.bodySmall,
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
