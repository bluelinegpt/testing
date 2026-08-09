import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';

final class CommunicationInboxPage extends StatelessWidget {
  const CommunicationInboxPage({super.key});
  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Text(
          l10n.communicationInbox,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: AppSpacing.md),
        AppErrorState(message: l10n.communicationUnavailable),
        Text(l10n.communicationSafetyNotice, textAlign: TextAlign.center),
      ],
    );
  }
}

final class ConversationPage extends StatelessWidget {
  const ConversationPage({required this.conversationId, super.key});
  final String conversationId;
  @override
  Widget build(BuildContext context) => AppErrorState(
    message: AppLocalizations.of(context).communicationUnavailable,
  );
}
