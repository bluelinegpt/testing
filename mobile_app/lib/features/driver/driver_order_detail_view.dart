import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart' as intl;

/// The single shared implementation of the "Driver field layout" required by
/// both a genuine `driver`-kind identity (`DriverOrderDetailsPage`, sourced
/// from the driver-portal endpoints) and a Driver User — a `company_user`
/// whose `linkedDriverId` resolved (`OperatorOrderDetailsPage` in
/// driver-presentation mode, sourced from the Operator endpoints instead,
/// since a `company_user` cannot call `/portal/driver/*`). Only the data
/// source differs between the two callers; the rendered field set, order,
/// and formatting are identical by construction.
final class DriverStyleOrderData {
  const DriverStyleOrderData({
    required this.serialNumber,
    required this.orderDate,
    required this.customerName,
    required this.customerMobile,
    required this.areaName,
    required this.address,
    required this.cod,
    required this.status,
    required this.traderName,
    this.reference,
    this.notes,
    this.emirateName,
  });
  final String serialNumber,
      orderDate,
      customerName,
      customerMobile,
      areaName,
      address,
      cod,
      status,
      traderName;
  final String? reference, notes, emirateName;
}

/// One grouped Material card in the redesigned Driver Order Detail layout —
/// a small icon + the card's field rows, relying on the app-wide
/// `cardTheme` (`app_theme.dart`: zero elevation, 16px rounded corners, a
/// light border) for its shape rather than redefining one locally.
final class _DriverDetailCard extends StatelessWidget {
  const _DriverDetailCard({
    required this.icon,
    required this.children,
    this.trailing,
  });
  final IconData icon;
  final List<Widget> children;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => BluelineSectionCard(
    padding: const EdgeInsets.all(AppSpacing.md),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 18, color: Theme.of(context).colorScheme.primary),
            if (trailing != null) ...[const Spacer(), trailing!],
          ],
        ),
        const SizedBox(height: AppSpacing.xs),
        ...children,
      ],
    ),
  );
}

/// A compact `label: value` row — replaces the far taller default-height
/// `ListTile` the pre-redesign layout used for every single field, which is
/// what made the original Order Detail screen read as visually loose.
final class _FieldRow extends StatelessWidget {
  const _FieldRow({required this.label, this.value, this.valueWidget});
  final String label;
  final String? value;
  final Widget? valueWidget;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs / 2),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 108,
          child: Text(
            label,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        Expanded(child: valueWidget ?? Text(value ?? '')),
      ],
    ),
  );
}

/// Renders the approved primary field set — grouped into a Header card
/// (Serial No., Reference, status), a Customer card (Name, Mobile, Call), a
/// Delivery card (Emirate, Area, Address, Open Map), and an Order card
/// (Order Date, COD, Trader, Notes) — `—` for a genuinely absent optional
/// value, never fabricated. History and status-action buttons are composed
/// by each caller around this, since those differ meaningfully by data
/// source (offline-aware sync badges for a genuine Driver vs. plain online
/// Operator-endpoint actions for a Driver User).
final class DriverStyleOrderFields extends StatelessWidget {
  const DriverStyleOrderFields({
    required this.order,
    required this.locale,
    super.key,
    this.onOpenUri,
  });
  final DriverStyleOrderData order;
  final String locale;
  final void Function(Uri uri, String errorMessage)? onOpenUri;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final reference = order.reference?.trim();
    final emirateName = order.emirateName?.trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _DriverDetailCard(
          icon: Icons.receipt_long_outlined,
          trailing: StatusChip(status: order.status),
          children: [
            _FieldRow(
              label: l10n.serialNumber,
              valueWidget: Directionality(
                textDirection: TextDirection.ltr,
                child: Text(
                  order.serialNumber,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
            ),
            _FieldRow(
              label: l10n.reference,
              value: (reference == null || reference.isEmpty)
                  ? l10n.emptyValuePlaceholder
                  : reference,
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        _DriverDetailCard(
          icon: Icons.person_outline,
          children: [
            _FieldRow(label: l10n.customer, value: order.customerName),
            _FieldRow(
              label: l10n.mobileLabel,
              valueWidget: Directionality(
                textDirection: TextDirection.ltr,
                child: Text(order.customerMobile),
              ),
            ),
            if (onOpenUri != null) ...[
              const SizedBox(height: AppSpacing.xs),
              OutlinedButton.icon(
                onPressed: isSafeCustomerContact(order.customerMobile)
                    ? () => onOpenUri!(
                        Uri(scheme: 'tel', path: order.customerMobile),
                        l10n.externalAppUnavailable,
                      )
                    : null,
                icon: const Icon(Icons.call_outlined),
                label: Text(l10n.callCustomer),
              ),
            ],
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        _DriverDetailCard(
          icon: Icons.location_on_outlined,
          children: [
            _FieldRow(
              label: l10n.emirate,
              value: (emirateName == null || emirateName.isEmpty)
                  ? l10n.emptyValuePlaceholder
                  : emirateName,
            ),
            _FieldRow(
              label: l10n.area,
              value: order.areaName.trim().isEmpty
                  ? l10n.emptyValuePlaceholder
                  : order.areaName,
            ),
            _FieldRow(
              label: l10n.address,
              value: order.address.trim().isEmpty
                  ? l10n.emptyValuePlaceholder
                  : order.address,
            ),
            if (onOpenUri != null) ...[
              const SizedBox(height: AppSpacing.xs),
              OutlinedButton.icon(
                onPressed: order.address.trim().isEmpty
                    ? null
                    : () => onOpenUri!(
                        Uri.https('www.google.com', '/maps/search/', {
                          'api': '1',
                          'query': order.address,
                        }),
                        l10n.externalAppUnavailable,
                      ),
                icon: const Icon(Icons.map_outlined),
                label: Text(l10n.openMap),
              ),
            ],
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        _DriverDetailCard(
          icon: Icons.inventory_2_outlined,
          children: [
            _FieldRow(
              label: l10n.orderDate,
              value: formatDriverOrderDate(order.orderDate, locale),
            ),
            _FieldRow(label: l10n.cod, value: 'AED ${order.cod}'),
            _FieldRow(label: l10n.traderLabel, value: order.traderName),
            if (order.notes != null)
              _FieldRow(label: l10n.notes, value: order.notes),
          ],
        ),
      ],
    );
  }
}

/// The single shared, role-safe Driver status-action UI — takes the already
/// resolved `Set<DriverAction>` (`actionsForDriverStatus`) and renders only
/// the buttons valid for the Order's current status, never every possible
/// status. Used by both a genuine Driver (`DriverOrderDetailsPage`) and a
/// Driver User (`OperatorOrderDetailsPage._driverPresentationBody`) — never
/// reachable from a plain Operator's own body or from any Trader page, so
/// this is the one place either caller's status-action buttons are defined.
final class DriverStatusActionsCard extends StatelessWidget {
  const DriverStatusActionsCard({
    required this.actions,
    required this.busy,
    required this.onAction,
    super.key,
  });
  final Set<DriverAction> actions;
  final bool busy;
  final void Function(DriverAction action) onAction;

  @override
  Widget build(BuildContext context) {
    if (actions.isEmpty) return const SizedBox.shrink();
    final l10n = AppLocalizations.of(context);
    return _DriverDetailCard(
      icon: Icons.touch_app_outlined,
      children: [
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.sm,
          children: [
            if (actions.contains(DriverAction.startDelivery))
              FilledButton(
                onPressed: busy
                    ? null
                    : () => onAction(DriverAction.startDelivery),
                child: Text(l10n.startDelivery),
              ),
            if (actions.contains(DriverAction.markDelivered))
              FilledButton.icon(
                onPressed: busy
                    ? null
                    : () => onAction(DriverAction.markDelivered),
                icon: const Icon(Icons.check_circle_outline),
                style: FilledButton.styleFrom(
                  backgroundColor: AppColors.success,
                ),
                label: Text(l10n.delivered),
              ),
            if (actions.contains(DriverAction.hold))
              OutlinedButton.icon(
                onPressed: busy ? null : () => onAction(DriverAction.hold),
                icon: const Icon(Icons.pause_circle_outline),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.warning,
                ),
                label: Text(l10n.hold),
              ),
            if (actions.contains(DriverAction.returnToBranch))
              OutlinedButton.icon(
                onPressed: busy
                    ? null
                    : () => onAction(DriverAction.returnToBranch),
                icon: const Icon(Icons.keyboard_return),
                style: OutlinedButton.styleFrom(
                  foregroundColor: AppColors.error,
                ),
                label: Text(l10n.returnToBranchAction),
              ),
          ],
        ),
      ],
    );
  }
}

/// The button/dialog label for a Driver action — the same string is used on
/// the action button itself and as the confirm/reason dialog's confirm
/// button, matching the established `_changeStatus` convention (e.g.
/// Return to Branch's confirm button already reads "Return to Branch", not
/// a generic "Confirm").
String driverActionLabel(DriverAction action, AppLocalizations l10n) =>
    switch (action) {
      DriverAction.startDelivery => l10n.startDelivery,
      DriverAction.markDelivered => l10n.delivered,
      DriverAction.hold => l10n.hold,
      DriverAction.returnToBranch => l10n.returnToBranchAction,
    };

/// The success snackbar text for a Driver action — Hold gets its own
/// explicit confirmation ("Order placed on Hold.") rather than the generic
/// "Status updated." so a Driver is never left wondering why the Order then
/// disappears from their Orders list on the next refresh (by design — see
/// `driverPortalOrderById` on the backend).
String driverActionSuccessMessage(DriverAction action, AppLocalizations l10n) =>
    switch (action) {
      DriverAction.startDelivery => l10n.deliveryStarted,
      DriverAction.hold => l10n.orderPlacedOnHold,
      DriverAction.markDelivered ||
      DriverAction.returnToBranch => l10n.statusUpdateCompleted,
    };

/// Shared reason-required confirmation dialog for a Driver-facing status
/// change (Hold, Return to Branch) — the same `TextField` + validation
/// behavior reused by both Driver code paths so neither ever drifts from the
/// other's UX. Returns the trimmed, non-empty reason, or `null` if
/// cancelled/left empty.
Future<String?> promptDriverStatusReason(
  BuildContext context, {
  required String title,
  required String confirmLabel,
}) {
  final l10n = AppLocalizations.of(context);
  return showDialog<String>(
    context: context,
    builder: (dialogContext) {
      final controller = TextEditingController();
      return StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: Text(title),
          content: TextField(
            controller: controller,
            autofocus: true,
            maxLength: 300,
            decoration: InputDecoration(labelText: l10n.reasonLabel),
            // A `StatefulBuilder` (rather than a bare `TextEditingController`
            // read once at dialog-build time) so the confirm button's
            // enabled state actually reacts as the Driver types — without
            // this, `controller.text` here is always the empty string the
            // dialog was built with, and the button never re-enables.
            onChanged: (_) => setDialogState(() {}),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: Text(l10n.cancel),
            ),
            FilledButton(
              onPressed: controller.text.trim().isEmpty
                  ? null
                  : () => Navigator.pop(dialogContext, controller.text.trim()),
              child: Text(confirmLabel),
            ),
          ],
        ),
      );
    },
  );
}

/// Shared no-reason confirmation dialog for a Driver-facing status change
/// (Start Delivery, Delivered).
Future<bool> promptDriverStatusConfirm(
  BuildContext context, {
  required String title,
  required String confirmLabel,
}) async {
  final l10n = AppLocalizations.of(context);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialogContext, false),
          child: Text(l10n.cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(dialogContext, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return confirmed == true;
}

String formatDriverOrderDate(String value, String locale) {
  final parsed = DateTime.tryParse(value);
  if (parsed == null) return value;
  return intl.DateFormat('dd MMM yyyy', locale).format(parsed);
}

/// Accepts both a plain ISO timestamp and the Postgres-style
/// `yyyy-MM-dd HH:mm:ss.ffffff+TZ` form (space-separated, no `T`) — the raw
/// shape History rows may arrive in from either the driver-portal or the
/// Operator endpoint.
DateTime? parseDriverServerTimestamp(String value) =>
    DateTime.tryParse(value) ?? DateTime.tryParse(value.replaceFirst(' ', 'T'));

/// Formats any raw History/debug timestamp human-readably in the viewer's
/// local (device) time zone — the app-wide convention already established by
/// `driver_pages.dart` (device time already reflects the Company/UAE
/// convention this app is built around; never a second, invented time zone
/// assumption). Falls back to the raw value only if it genuinely cannot be
/// parsed, never a blank string.
String formatDriverHistoryTimestamp(String value, String locale) {
  final parsed = parseDriverServerTimestamp(value)?.toLocal();
  if (parsed == null) return value;
  return intl.DateFormat('dd MMM yyyy, h:mm a', locale).format(parsed);
}

String driverHistoryTransitionLabel(
  DriverOrderHistoryEvent event,
  AppLocalizations l10n,
) {
  final fromLabel = event.fromStatus == null
      ? l10n.emptyValuePlaceholder
      : OrderStatusMapper.label(
          OrderStatusMapper.parse(event.fromStatus!),
          l10n,
        );
  final toLabel = OrderStatusMapper.label(
    OrderStatusMapper.parse(event.toStatus),
    l10n,
  );
  return '$fromLabel → $toLabel';
}

/// Read-only, collapsed-by-default Order History section for a caller that
/// already has every History row in hand (no extra network round trip) —
/// used by the Driver-presentation `OperatorOrderDetailsPage` path, whose
/// `detail()` call already returns `history` eagerly in the same response.
/// `DriverOrderDetailsPage` (genuine Driver, driver-portal data) keeps its
/// own pre-existing lazy-fetch-on-first-expansion History implementation
/// unchanged — that path has offline-sync-pending-row behavior this section
/// deliberately does not need to replicate, since a Driver User has no
/// offline queue at all (its actions call the Operator endpoints directly).
final class DriverOrderHistorySection extends StatefulWidget {
  const DriverOrderHistorySection({required this.events, super.key});
  final List<DriverOrderHistoryEvent> events;
  @override
  State<DriverOrderHistorySection> createState() =>
      _DriverOrderHistorySectionState();
}

final class _DriverOrderHistorySectionState
    extends State<DriverOrderHistorySection> {
  // `ExpansionTile` keeps its `children` mounted (just visually clipped to
  // zero height) rather than removing them from the tree while collapsed —
  // so rows are only actually included in `children` while `_expanded` is
  // true, matching the same "collapsed means absent, not merely invisible"
  // behavior `DriverOrderDetailsPage`'s pre-existing lazy-fetch History
  // section already has.
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    return Card(
      child: ExpansionTile(
        title: Text('${l10n.orderHistory} (${widget.events.length})'),
        initiallyExpanded: false,
        onExpansionChanged: (expanded) => setState(() => _expanded = expanded),
        children: [
          if (_expanded)
            if (widget.events.isEmpty)
              AppEmptyState(message: l10n.dataUnavailable)
            else
              for (final event in widget.events)
                ListTile(
                  leading: const Icon(Icons.history),
                  title: Text(driverHistoryTransitionLabel(event, l10n)),
                  subtitle: Text(
                    formatDriverHistoryTimestamp(event.occurredAt, locale),
                  ),
                ),
        ],
      ),
    );
  }
}
