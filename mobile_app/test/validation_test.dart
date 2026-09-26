import 'package:bluelinegpt_mobile/core/validation/safe_parsers.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('safe numeric parsing', () {
    test('accepts valid decimal and Arabic numerals', () {
      expect(SafeNumberParser.parse('125.50').value, 125.5);
      expect(SafeNumberParser.parse('١٢٥٫٥٠').value, 125.5);
    });

    test('rejects malformed COD values without throwing', () {
      for (final value in [
        '',
        'abc',
        '12.3.4',
        '-1',
        '1e999',
        '999999999999999999',
      ]) {
        expect(() => SafeNumberParser.parse(value), returnsNormally);
        expect(SafeNumberParser.parse(value).isValid, isFalse);
      }
    });
  });

  group('UAE mobile validation', () {
    test('accepts and normalizes the approved format', () {
      expect(UaeMobileValidator.isValid('+971506468441'), isTrue);
      expect(UaeMobileValidator.isValid('+971 50 646 8441'), isTrue);
    });

    test('rejects letters and invalid lengths safely', () {
      expect(UaeMobileValidator.isValid('+97150ABC8441'), isFalse);
      expect(UaeMobileValidator.isValid('+9715012'), isFalse);
    });
  });
}
