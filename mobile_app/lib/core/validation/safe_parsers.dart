import 'package:flutter/services.dart';

enum NumericValidationError { empty, malformed, negative, overflow }

final class NumericParseResult {
  const NumericParseResult.valid(this.value) : error = null;
  const NumericParseResult.invalid(this.error) : value = null;
  final double? value;
  final NumericValidationError? error;
  bool get isValid => error == null;
}

abstract final class SafeNumberParser {
  static const _maxSafeAmount = 999999999999.99;
  static const _arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  static const _persianDigits = '۰۱۲۳۴۵۶۷۸۹';

  static String normalize(String input) {
    var value = input.trim().replaceAll('٫', '.').replaceAll('٬', '');
    for (var index = 0; index < 10; index++) {
      value = value
          .replaceAll(_arabicDigits[index], '$index')
          .replaceAll(_persianDigits[index], '$index');
    }
    return value;
  }

  static NumericParseResult parse(String input, {bool allowNegative = false}) {
    final normalized = normalize(input);
    if (normalized.isEmpty) {
      return const NumericParseResult.invalid(NumericValidationError.empty);
    }
    if (!RegExp(r'^-?\d+(\.\d{1,2})?$').hasMatch(normalized)) {
      return const NumericParseResult.invalid(NumericValidationError.malformed);
    }
    final value = double.tryParse(normalized);
    if (value == null || !value.isFinite || value.abs() > _maxSafeAmount) {
      return const NumericParseResult.invalid(NumericValidationError.overflow);
    }
    if (!allowNegative && value < 0) {
      return const NumericParseResult.invalid(NumericValidationError.negative);
    }
    return NumericParseResult.valid(value);
  }
}

final class SafeDecimalInputFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final normalized = SafeNumberParser.normalize(newValue.text);
    if (normalized.isEmpty ||
        RegExp(r'^\d*(\.\d{0,2})?$').hasMatch(normalized)) {
      return newValue.copyWith(
        text: normalized,
        selection: TextSelection.collapsed(offset: normalized.length),
      );
    }
    return oldValue;
  }
}

abstract final class UaeMobileValidator {
  static String normalize(String input) =>
      input.replaceAll(RegExp(r'[\s()-]'), '');

  static bool isValid(String input) {
    final value = normalize(input);
    return RegExp(r'^\+9715[024568]\d{7}$').hasMatch(value);
  }
}
