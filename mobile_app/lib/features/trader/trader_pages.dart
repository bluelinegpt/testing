import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/validation/safe_parsers.dart';
import 'package:bluelinegpt_mobile/features/common/pages.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_pages.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_pages.dart';
import 'package:bluelinegpt_mobile/features/customer/customer_pages.dart';
import 'package:bluelinegpt_mobile/features/trader/trader_models.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

final class RoleOrdersPage extends ConsumerWidget {
  const RoleOrdersPage({super.key, this.initialDeliveryStatus});
  final String? initialDeliveryStatus;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authenticationProvider).value?.user;
    if (user?.hasRole(UserRole.trader) == true) return const TraderOrdersPage();
    if (user?.hasRole(UserRole.driver) == true) {
      return DriverOrdersPage(initialDeliveryStatus: initialDeliveryStatus);
    }
    if (user?.hasRole(UserRole.operatorRole) == true) {
      return hasOperatorOrderAccess(user!.permissions)
          ? OperatorOrdersPage(initialDeliveryStatus: initialDeliveryStatus)
          : MessagePage(
              message: AppLocalizations.of(context).operatorAccessRequired,
            );
    }
    if (user?.hasRole(UserRole.customer) == true) {
      return const CustomerAccountUnavailablePage();
    }
    return PlaceholderPage(title: AppLocalizations.of(context).orders);
  }
}

final class TraderOrdersPage extends ConsumerStatefulWidget {
  const TraderOrdersPage({super.key});
  @override
  ConsumerState<TraderOrdersPage> createState() => _TraderOrdersPageState();
}

final class _TraderOrdersPageState extends ConsumerState<TraderOrdersPage> {
  late Future<List<TraderOrder>> future;
  @override
  void initState() {
    super.initState();
    future = ref.read(traderRepositoryProvider).orders();
  }

  Future<void> refresh() async {
    final next = ref.read(traderRepositoryProvider).orders();
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
          AppSearchField(onChanged: (_) {}, loading: false),
          const SizedBox(height: AppSpacing.sm),
          Text(
            l10n.ordersLimited,
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.md),
          FutureBuilder<List<TraderOrder>>(
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
                        cod: order.cod,
                        deliveryFee: order.serviceFee,
                        netExpected: order.netExpected,
                        status: order.status,
                      ),
                      audience: OrderAudience.trader,
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

final class CreateTraderOrderPage extends ConsumerStatefulWidget {
  const CreateTraderOrderPage({super.key});
  @override
  ConsumerState<CreateTraderOrderPage> createState() =>
      _CreateTraderOrderPageState();
}

final class _CreateTraderOrderPageState
    extends ConsumerState<CreateTraderOrderPage> {
  final formKey = GlobalKey<FormState>();
  final reference = TextEditingController();
  final name = TextEditingController();
  final mobile = TextEditingController(text: '+971');
  final address = TextEditingController();
  final cod = TextEditingController();
  final notes = TextEditingController();
  String? emirateId;
  String? areaId;
  TraderPricingPreview? pricing;
  String? pricingError;
  late final Future<List<TraderArea>> areasFuture;

  @override
  void initState() {
    super.initState();
    areasFuture = ref.read(traderRepositoryProvider).areas();
  }

  @override
  void dispose() {
    for (final value in [reference, name, mobile, address, cod, notes]) {
      value.dispose();
    }
    super.dispose();
  }

  TraderOrderDraft get draft => TraderOrderDraft(
    reference: reference.text.isEmpty ? null : reference.text,
    customerName: name.text,
    customerMobile: mobile.text,
    areaId: areaId ?? '',
    address: address.text,
    cod: cod.text,
    notes: notes.text.isEmpty ? null : notes.text,
  );

  Future<void> requestPricing() async {
    if (areaId == null || cod.text.isEmpty) return;
    setState(() {
      pricing = null;
      pricingError = null;
    });
    try {
      final result = await ref
          .read(traderRepositoryProvider)
          .previewPricing(draft);
      if (mounted) {
        setState(() => pricing = result);
      }
    } on Object {
      if (mounted) {
        setState(
          () => pricingError = AppLocalizations.of(context).pricingUnavailable,
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return FutureBuilder<List<TraderArea>>(
      future: areasFuture,
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return AppErrorState(message: l10n.dataUnavailable);
        }
        final areas = snapshot.data ?? const [];
        final emirates = {
          for (final area in areas)
            area.emirateId: Localizations.localeOf(context).languageCode == 'ar'
                ? (area.emirateNameAr ?? area.emirateNameEn)
                : area.emirateNameEn,
        };
        final availableAreas = areas
            .where((item) => item.emirateId == emirateId)
            .toList();
        return Form(
          key: formKey,
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            children: [
              TextFormField(
                controller: reference,
                decoration: InputDecoration(labelText: l10n.externalReference),
                validator: (value) =>
                    value != null &&
                        value.isNotEmpty &&
                        TraderOrderDraft(
                          customerName: 'x',
                          customerMobile: '+971506468441',
                          areaId: 'x',
                          address: 'x',
                          cod: '0',
                          reference: value,
                        ).validate().containsKey('reference')
                    ? l10n.invalidReference
                    : null,
              ),
              const SizedBox(height: AppSpacing.md),
              TextFormField(
                controller: name,
                decoration: InputDecoration(labelText: l10n.customerName),
                validator: (value) => value == null || value.trim().isEmpty
                    ? l10n.requiredField
                    : null,
              ),
              const SizedBox(height: AppSpacing.md),
              TextFormField(
                controller: mobile,
                keyboardType: TextInputType.phone,
                textDirection: TextDirection.ltr,
                decoration: InputDecoration(labelText: l10n.customerMobile),
                validator: (value) =>
                    value == null || !UaeMobileValidator.isValid(value)
                    ? l10n.invalidMobile
                    : null,
              ),
              const SizedBox(height: AppSpacing.md),
              DropdownButtonFormField<String>(
                initialValue: emirateId,
                decoration: InputDecoration(labelText: l10n.selectEmirate),
                items: [
                  for (final item in emirates.entries)
                    DropdownMenuItem(value: item.key, child: Text(item.value)),
                ],
                onChanged: (value) => setState(() {
                  emirateId = value;
                  areaId = null;
                  pricing = null;
                }),
                validator: (value) => value == null ? l10n.requiredField : null,
              ),
              const SizedBox(height: AppSpacing.md),
              DropdownButtonFormField<String>(
                initialValue: areaId,
                decoration: InputDecoration(labelText: l10n.selectArea),
                items: [
                  for (final area in availableAreas)
                    DropdownMenuItem(
                      value: area.id,
                      child: Text(
                        Localizations.localeOf(context).languageCode == 'ar'
                            ? (area.nameAr ?? area.nameEn)
                            : area.nameEn,
                      ),
                    ),
                ],
                onChanged: emirateId == null
                    ? null
                    : (value) {
                        setState(() {
                          areaId = value;
                          pricing = null;
                        });
                        requestPricing();
                      },
                validator: (value) => value == null ? l10n.requiredField : null,
              ),
              const SizedBox(height: AppSpacing.md),
              TextFormField(
                controller: address,
                maxLines: 4,
                decoration: InputDecoration(labelText: l10n.address),
                validator: (value) => value == null || value.trim().isEmpty
                    ? l10n.requiredField
                    : null,
              ),
              const SizedBox(height: AppSpacing.md),
              TextFormField(
                controller: cod,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                inputFormatters: [SafeDecimalInputFormatter()],
                decoration: InputDecoration(labelText: l10n.cod),
                onChanged: (_) => requestPricing(),
                validator: (value) =>
                    value == null || draft.validate().containsKey('cod')
                    ? l10n.invalidNumber
                    : null,
              ),
              const SizedBox(height: AppSpacing.md),
              TextFormField(
                controller: notes,
                maxLines: 3,
                decoration: InputDecoration(labelText: l10n.notes),
              ),
              if (pricingError != null)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.md),
                  child: AppErrorState(message: pricingError!),
                ),
              const SizedBox(height: AppSpacing.lg),
              FilledButton(
                onPressed: pricing == null
                    ? null
                    : () {
                        if (formKey.currentState?.validate() == true) {
                          context.push('/create-order/review');
                        }
                      },
                child: Text(
                  pricing == null ? l10n.pricingRequired : l10n.reviewOrder,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

final class TraderOrderReviewPage extends StatelessWidget {
  const TraderOrderReviewPage({super.key});
  @override
  Widget build(BuildContext context) =>
      AppErrorState(message: AppLocalizations.of(context).pricingUnavailable);
}

final class TraderOrderDetailsPage extends StatelessWidget {
  const TraderOrderDetailsPage({required this.orderId, super.key});
  final String orderId;
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(AppSpacing.md),
    children: [
      AppErrorState(
        message: AppLocalizations.of(context).orderDetailsUnavailable,
      ),
      FilledButton.tonalIcon(
        onPressed: null,
        icon: const Icon(Icons.chat_outlined),
        label: Text(AppLocalizations.of(context).messageOffice),
      ),
    ],
  );
}

final class TraderFinancePage extends StatelessWidget {
  const TraderFinancePage({required this.title, super.key});
  final String title;
  @override
  Widget build(BuildContext context) => AppErrorState(
    message: AppLocalizations.of(context).traderFinanceUnavailable,
  );
}
