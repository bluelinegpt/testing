import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/core/validation/safe_parsers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

final class AppTextField extends StatelessWidget {
  const AppTextField({
    required this.label,
    super.key,
    this.controller,
    this.required = false,
    this.readOnly = false,
    this.enabled = true,
    this.keyboardType,
    this.inputFormatters,
    this.validator,
    this.maxLines = 1,
    this.obscureText = false,
  });

  final String label;
  final TextEditingController? controller;
  final bool required;
  final bool readOnly;
  final bool enabled;
  final TextInputType? keyboardType;
  final List<TextInputFormatter>? inputFormatters;
  final String? Function(String?)? validator;
  final int maxLines;
  final bool obscureText;

  @override
  Widget build(BuildContext context) => Semantics(
    textField: true,
    label: label,
    child: TextFormField(
      controller: controller,
      readOnly: readOnly,
      enabled: enabled,
      keyboardType: keyboardType,
      inputFormatters: inputFormatters,
      maxLines: maxLines,
      obscureText: obscureText,
      decoration: InputDecoration(labelText: required ? '$label *' : label),
      validator:
          validator ??
          (required
              ? (value) => value == null || value.trim().isEmpty
                    ? AppLocalizations.of(context).requiredField
                    : null
              : null),
    ),
  );
}

final class NumericAppTextField extends StatelessWidget {
  const NumericAppTextField({
    required this.label,
    super.key,
    this.controller,
    this.required = false,
  });
  final String label;
  final TextEditingController? controller;
  final bool required;

  @override
  Widget build(BuildContext context) => AppTextField(
    label: label,
    controller: controller,
    required: required,
    keyboardType: const TextInputType.numberWithOptions(decimal: true),
    inputFormatters: [SafeDecimalInputFormatter()],
    validator: (value) {
      if (!required && (value == null || value.isEmpty)) return null;
      return SafeNumberParser.parse(value ?? '').isValid
          ? null
          : AppLocalizations.of(context).invalidNumber;
    },
  );
}

final class LoadingButton extends StatelessWidget {
  const LoadingButton({
    required this.label,
    required this.onPressed,
    super.key,
    this.loading = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  @override
  Widget build(BuildContext context) => FilledButton(
    onPressed: loading ? null : onPressed,
    child: loading
        ? const SizedBox.square(
            dimension: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        : Text(label),
  );
}

final class MobileNumberField extends StatelessWidget {
  const MobileNumberField({required this.label, super.key, this.controller});
  final String label;
  final TextEditingController? controller;
  @override
  Widget build(BuildContext context) => AppTextField(
    label: label,
    controller: controller,
    keyboardType: TextInputType.phone,
    validator: (value) => UaeMobileValidator.isValid(value ?? '')
        ? null
        : AppLocalizations.of(context).invalidMobile,
  );
}

final class PasswordAppField extends StatelessWidget {
  const PasswordAppField({required this.label, super.key, this.controller});
  final String label;
  final TextEditingController? controller;
  @override
  Widget build(BuildContext context) => AppTextField(
    label: label,
    controller: controller,
    required: true,
    obscureText: true,
  );
}

final class MultilineAppField extends StatelessWidget {
  const MultilineAppField({required this.label, super.key, this.controller});
  final String label;
  final TextEditingController? controller;
  @override
  Widget build(BuildContext context) => AppTextField(
    label: label,
    controller: controller,
    maxLines: 4,
    keyboardType: TextInputType.multiline,
  );
}

final class AppDropdown<T> extends StatelessWidget {
  const AppDropdown({
    required this.label,
    required this.items,
    required this.itemLabel,
    required this.onChanged,
    super.key,
    this.value,
  });
  final String label;
  final List<T> items;
  final String Function(T) itemLabel;
  final ValueChanged<T?> onChanged;
  final T? value;

  @override
  Widget build(BuildContext context) => DropdownButtonFormField<T>(
    initialValue: value,
    decoration: InputDecoration(labelText: label),
    items: [
      for (final item in items)
        DropdownMenuItem(value: item, child: Text(itemLabel(item))),
    ],
    onChanged: onChanged,
  );
}

final class DatePlaceholderField extends StatelessWidget {
  const DatePlaceholderField({
    required this.label,
    required this.onTap,
    super.key,
  });
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => TextFormField(
    readOnly: true,
    onTap: onTap,
    decoration: InputDecoration(
      labelText: label,
      suffixIcon: const Icon(Icons.calendar_today_outlined),
    ),
  );
}

final class ValidationMessage extends StatelessWidget {
  const ValidationMessage(this.message, {super.key});
  final String message;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Text(
      message,
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    ),
  );
}

Future<bool> showAppConfirmation(
  BuildContext context, {
  required String title,
  required String confirmLabel,
  required String cancelLabel,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(cancelLabel),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    ) ??
    false;

Future<T?> showAppSelector<T>(
  BuildContext context, {
  required List<T> items,
  required String Function(T) itemLabel,
}) => showModalBottomSheet<T>(
  context: context,
  showDragHandle: true,
  builder: (context) => SafeArea(
    child: ListView(
      shrinkWrap: true,
      children: [
        for (final item in items)
          ListTile(
            title: Text(itemLabel(item)),
            onTap: () => Navigator.pop(context, item),
          ),
      ],
    ),
  ),
);
