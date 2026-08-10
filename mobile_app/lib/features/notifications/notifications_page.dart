import 'dart:async';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:bluelinegpt_mobile/features/notifications/notification_permission_banner.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart' as intl;

/// The Notification Inbox — follows the same
/// FutureBuilder/ListView/RefreshIndicator/`AppErrorState`/`AppEmptyState`
/// structural convention as `DriverOrdersPage`
/// (`lib/features/driver/driver_pages.dart`), adapted for
/// `NotificationInboxController`'s append-on-load-more pagination instead of
/// a single flat list.
final class NotificationsPage extends ConsumerStatefulWidget {
  const NotificationsPage({super.key});
  @override
  ConsumerState<NotificationsPage> createState() => _NotificationsPageState();
}

final class _NotificationsPageState extends ConsumerState<NotificationsPage> {
  late final NotificationInboxController controller;
  bool loading = true;
  bool loadingMore = false;
  Object? error;

  @override
  void initState() {
    super.initState();
    controller = NotificationInboxController(
      ref.read(notificationInboxRepositoryProvider),
    );
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      await controller.load(refresh: true);
      if (!mounted) return;
      setState(() => loading = false);
    } on Object catch (value) {
      if (!mounted) return;
      setState(() {
        error = value;
        loading = false;
      });
    }
  }

  Future<void> _loadMore() async {
    if (controller.nextCursor == null || loadingMore) return;
    setState(() => loadingMore = true);
    try {
      await controller.load();
    } on Object {
      // A failed "load more" leaves the already-visible list intact — the
      // user can retry via the same control.
    }
    if (mounted) setState(() => loadingMore = false);
  }

  Future<void> _markAllRead() async {
    try {
      await controller.markAllRead();
      if (mounted) setState(() {});
    } on Object {
      // Best-effort — a failure here leaves items exactly as they were.
    }
  }

  Future<void> _openItem(MobileNotification item) async {
    if (!item.isRead) {
      try {
        await controller.markRead(item.id);
      } on Object {
        // Navigation must still proceed even if marking read fails — it
        // will be retried the next time the inbox is opened.
      }
    }
    if (!mounted) return;
    setState(() {});
    final destination = NotificationRouter.parse({
      'targetType': item.targetType,
      'targetId': item.targetId,
    });
    switch (destination) {
      case MessageNotificationDestination(:final conversationId):
        context.push('/messages/$conversationId');
      case OrderNotificationDestination(:final orderId):
        context.push('/orders/$orderId');
      case NotificationCenterDestination():
        break; // Already on this screen — nothing to navigate to.
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    // A foreground push (FCM) or a live WebSocket event both only ever mean
    // "go re-fetch the truth from the server" here — never an independent
    // increment — so a duplicate signal from both paths still only causes
    // one extra (idempotent) refresh, never a double-counted unread state.
    ref.listen(communicationRefreshSignalProvider, (_, _) => _load());
    ref.listen(ordersRefreshSignalProvider, (_, _) => _load());
    final items = controller.items;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          const NotificationPermissionBanner(),
          const SizedBox(height: AppSpacing.sm),
          if (loading && items.isEmpty)
            const DashboardSkeleton()
          else if (error != null && items.isEmpty)
            SizedBox(
              height: MediaQuery.sizeOf(context).height * .5,
              child: AppErrorState(
                message: l10n.dataUnavailable,
                onRetry: _load,
              ),
            )
          else if (items.isEmpty)
            AppEmptyState(
              message: l10n.noNotifications,
              icon: Icons.notifications_none,
            )
          else ...[
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton(
                key: const Key('markAllReadButton'),
                onPressed: _markAllRead,
                child: Text(l10n.markAllRead),
              ),
            ),
            for (final item in items) ...[
              _NotificationTile(item: item, onTap: () => _openItem(item)),
              const SizedBox(height: AppSpacing.sm),
            ],
            if (controller.nextCursor != null)
              Center(
                child: loadingMore
                    ? const Padding(
                        padding: EdgeInsets.all(AppSpacing.md),
                        child: SizedBox.square(
                          dimension: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : TextButton(
                        onPressed: _loadMore,
                        child: Text(l10n.loadMore),
                      ),
              ),
          ],
        ],
      ),
    );
  }
}

final class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.item, required this.onTap});
  final MobileNotification item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final title = titleForNotification(item.titleKey, l10n);
    final body = bodyForNotification(
      notificationType: item.notificationType,
      bodyKey: item.bodyKey,
      bodyParams: item.bodyParams,
      l10n: l10n,
    );
    return Card(
      color: item.isRead
          ? null
          : Theme.of(context).colorScheme.primaryContainer,
      child: ListTile(
        leading: Icon(_iconFor(item.notificationType)),
        title: Text(
          title,
          style: item.isRead
              ? null
              : const TextStyle(fontWeight: FontWeight.bold),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (body != null) Text(body),
            Text(
              _formatTimestamp(item.createdAt, locale),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
        trailing: item.isRead
            ? null
            : const Icon(Icons.circle, size: 10, color: AppColors.info),
        onTap: onTap,
      ),
    );
  }
}

IconData _iconFor(String notificationType) => switch (notificationType) {
  'communication.message.created' => Icons.chat_bubble_outline,
  'order.assigned' || 'order.reassigned' => Icons.assignment_ind_outlined,
  'order.status_changed' => Icons.local_shipping_outlined,
  _ => Icons.notifications_none,
};

String _formatTimestamp(DateTime value, String locale) =>
    intl.DateFormat('dd MMM yyyy, h:mm a', locale).format(value.toLocal());
