import 'dart:async';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum _BannerState { loading, hidden, askable, denied, permanentlyDenied }

/// The Prompt 15 §T permission-UX flow — shown once, not on every launch,
/// and never a blocking modal. Design choice: placed as a card at the top of
/// the Notifications page (rather than the Dashboard) since it is directly
/// relevant to what that screen shows, and a Driver/Trader/Operator visiting
/// Notifications at least once is a reasonably safe assumption for this
/// phase.
///
/// States:
///  - not-yet-asked → explain text + Enable button.
///  - authorized → renders nothing.
///  - denied (asked once, not authorized) → a quiet "notifications off" row,
///    never repeated nagging.
///  - permanently denied (Android "don't ask again" / iOS after first
///    denial) → the same quiet row, plus an "Open Settings" action.
final class NotificationPermissionBanner extends ConsumerStatefulWidget {
  const NotificationPermissionBanner({super.key});
  @override
  ConsumerState<NotificationPermissionBanner> createState() =>
      _NotificationPermissionBannerState();
}

final class _NotificationPermissionBannerState
    extends ConsumerState<NotificationPermissionBanner> {
  _BannerState state = _BannerState.loading;

  @override
  void initState() {
    super.initState();
    unawaited(_refresh());
  }

  Future<void> _refresh() async {
    final coordinator = ref.read(pushMessagingCoordinatorProvider);
    final storage = ref.read(storageProvider);
    final status = await coordinator.permissionStatus();
    if (status == NotificationPermissionState.authorized) {
      if (mounted) setState(() => state = _BannerState.hidden);
      return;
    }
    final asked = await storage.read(SensitiveKey.notificationPermissionAsked);
    if (asked != 'true') {
      if (mounted) setState(() => state = _BannerState.askable);
      return;
    }
    final permanentlyDenied = await coordinator.isPermanentlyDenied();
    if (!mounted) return;
    setState(
      () => state = permanentlyDenied
          ? _BannerState.permanentlyDenied
          : _BannerState.denied,
    );
  }

  Future<void> _enable() async {
    final storage = ref.read(storageProvider);
    await storage.write(SensitiveKey.notificationPermissionAsked, 'true');
    final coordinator = ref.read(pushMessagingCoordinatorProvider);
    final result = await coordinator.requestPermission();
    if (result != NotificationPermissionState.authorized) {
      final raw = await storage.read(
        SensitiveKey.notificationPermissionDenialCount,
      );
      final count = (int.tryParse(raw ?? '0') ?? 0) + 1;
      await storage.write(
        SensitiveKey.notificationPermissionDenialCount,
        '$count',
      );
    }
    await _refresh();
  }

  Future<void> _openSettings() async {
    await ref.read(pushMessagingCoordinatorProvider).openSettings();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    switch (state) {
      case _BannerState.loading:
      case _BannerState.hidden:
        return const SizedBox.shrink();
      case _BannerState.askable:
        return Card(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.notifications_active_outlined),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(child: Text(l10n.notificationPermissionRequired)),
                  ],
                ),
                const SizedBox(height: AppSpacing.sm),
                Align(
                  alignment: AlignmentDirectional.centerEnd,
                  child: FilledButton(
                    key: const Key('enableNotificationsButton'),
                    onPressed: _enable,
                    child: Text(l10n.enableNotifications),
                  ),
                ),
              ],
            ),
          ),
        );
      case _BannerState.denied:
        return Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.md,
            vertical: AppSpacing.xs,
          ),
          child: Semantics(
            liveRegion: true,
            child: Row(
              children: [
                const Icon(Icons.notifications_off_outlined, size: 18),
                const SizedBox(width: AppSpacing.xs),
                Expanded(
                  child: Text(
                    l10n.notificationPermissionDenied,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ),
        );
      case _BannerState.permanentlyDenied:
        return Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.md,
            vertical: AppSpacing.xs,
          ),
          child: Semantics(
            liveRegion: true,
            child: Row(
              children: [
                const Icon(Icons.notifications_off_outlined, size: 18),
                const SizedBox(width: AppSpacing.xs),
                Expanded(
                  child: Text(
                    l10n.notificationPermissionDenied,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                TextButton(
                  key: const Key('openNotificationSettingsButton'),
                  onPressed: _openSettings,
                  child: Text(l10n.openNotificationSettings),
                ),
              ],
            ),
          ),
        );
    }
  }
}
