import 'package:bluelinegpt_mobile/features/trader/trader_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TraderOrderDraft validDraft({String? reference = '000-A'}) =>
      TraderOrderDraft(
        customerName: 'Customer',
        customerMobile: '+971 50 646 8441',
        areaId: 'area-1',
        address: 'Dubai Marina',
        cod: '150.25',
        reference: reference,
      );

  group('Trader order draft', () {
    test('accepts valid UAE data and preserves leading zero reference', () {
      final draft = validDraft();
      expect(draft.validate(), isEmpty);
      expect(draft.normalizedReference, '000-A');
    });

    test('allows an absent optional reference', () {
      expect(validDraft(reference: null).validate(), isEmpty);
    });

    test('rejects an empty supplied reference', () {
      expect(validDraft(reference: ' ').validate(), contains('reference'));
    });

    test('rejects invalid mobile', () {
      final draft = TraderOrderDraft(
        customerName: 'Customer',
        customerMobile: '0500000000',
        areaId: 'area-1',
        address: 'Dubai',
        cod: '10',
      );
      expect(draft.validate(), contains('customerMobile'));
    });

    test('rejects malformed and over-precision COD', () {
      final draft = TraderOrderDraft(
        customerName: 'Customer',
        customerMobile: '+971506468441',
        areaId: 'area-1',
        address: 'Dubai',
        cod: '10.999',
      );
      expect(draft.validate(), contains('cod'));
    });
  });

  group('Trader workflow safety', () {
    test('only known pre-delivery statuses are locally cancellable', () {
      expect(locallyCancellable('new'), isTrue);
      expect(locallyCancellable('assigned'), isTrue);
      expect(locallyCancellable('assigned_to_driver'), isTrue);
      expect(locallyCancellable('out_for_delivery'), isFalse);
      expect(locallyCancellable('delivered'), isFalse);
      expect(locallyCancellable('unknown'), isFalse);
    });

    test('pricing version change requires reconfirmation', () {
      const old = TraderPricingPreview(
        cod: '100',
        deliveryFee: '10',
        netExpected: '90',
        version: 'v1',
      );
      const changed = TraderPricingPreview(
        cod: '100',
        deliveryFee: '10',
        netExpected: '90',
        version: 'v2',
      );
      expect(pricingChanged(old, changed), isTrue);
      expect(pricingChanged(old, old), isFalse);
    });

    test('submission guard prevents duplicate concurrent submits', () {
      final guard = TraderSubmissionGuard('order-key');
      expect(guard.begin(), isTrue);
      expect(guard.begin(), isFalse);
      expect(guard.idempotencyKey, 'order-key');
      guard.finish();
      expect(guard.begin(), isTrue);
    });
  });
}
