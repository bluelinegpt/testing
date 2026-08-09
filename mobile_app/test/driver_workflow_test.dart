import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Driver status actions', () {
    test('assigned Order only permits Start Delivery', () {
      expect(actionsForDriverStatus('assigned_to_driver'), {
        DriverAction.startDelivery,
      });
    });
    test('Out for Delivery exposes only delivery outcomes', () {
      expect(actionsForDriverStatus('out_for_delivery'), {
        DriverAction.markDelivered,
        DriverAction.reportFailure,
      });
    });
    test('terminal and unknown states expose no mutation', () {
      for (final status in [
        'delivered',
        'returned_to_branch',
        'returned_to_trader',
        'cancelled',
        'unknown',
      ]) {
        expect(actionsForDriverStatus(status), isEmpty);
      }
    });
  });

  group('Delivery confirmation validation', () {
    test('accepts exact cash collection', () {
      const draft = DeliveryConfirmationDraft(
        expectedCod: '100.00',
        actualCod: '100',
        paymentMethod: DriverPaymentMethod.cash,
      );
      expect(draft.validate(), isEmpty);
    });
    test('requires Bank reference for Bank collection', () {
      const draft = DeliveryConfirmationDraft(
        expectedCod: '100',
        actualCod: '100',
        paymentMethod: DriverPaymentMethod.bank,
      );
      expect(draft.validate(), contains('bankReference'));
    });
    test('rejects unsupported COD difference', () {
      const draft = DeliveryConfirmationDraft(
        expectedCod: '100',
        actualCod: '90',
        paymentMethod: DriverPaymentMethod.cash,
      );
      expect(draft.validate()['actualCod'], 'difference_unsupported');
    });
    test('rejects malformed pasted COD without throwing', () {
      const draft = DeliveryConfirmationDraft(
        expectedCod: '100',
        actualCod: '1O0<script>',
        paymentMethod: DriverPaymentMethod.cash,
      );
      expect(draft.validate(), contains('actualCod'));
    });
  });

  test('Customer contact accepts only centralized UAE format', () {
    expect(isSafeCustomerContact('+971 50 646 8441'), isTrue);
    expect(isSafeCustomerContact('javascript:alert(1)'), isFalse);
  });
}
