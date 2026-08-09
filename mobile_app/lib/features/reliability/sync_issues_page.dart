import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';

final class SyncIssuesPage extends StatelessWidget {
  const SyncIssuesPage({super.key});

  @override
  Widget build(BuildContext context) {
    final arabic = Localizations.localeOf(context).languageCode == 'ar';
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Text(
          arabic ? 'حالة المزامنة' : 'Synchronization status',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: AppSpacing.md),
        AppErrorState(
          message: arabic
              ? 'المزامنة الآمنة غير متاحة حتى يتم توفير خدمة الخادم. لن تظهر الإجراءات المعلقة كمؤكدة.'
              : 'Secure synchronization is unavailable until the server service is supplied. Pending actions will not appear as confirmed.',
        ),
      ],
    );
  }
}
