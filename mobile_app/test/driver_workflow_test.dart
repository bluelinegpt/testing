import 'package:bluelinegpt_mobile/features/driver/driver_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Driver status actions', () {
    test('assigned Order only permits Start Delivery', () {
      expect(actionsForDriverStatus('assigned_to_driver'), {
        DriverAction.startDelivery,
      });
    });
    test('Out for Delivery exposes exactly Delivered, Hold, and Return to '
        'Branch', () {
      // No separate "report failure" concept — the backend's only reachable
      // targets from `out_for_delivery` are `delivered`, `hold`, and
      // `returned_to_branch` (`operations.service.ts` `driverTransitions`
      // inside `changeOrderStatus`). Hold is not a new backend status — it
      // is newly reachable by a Driver from this one source status only.
      expect(actionsForDriverStatus('out_for_delivery'), {
        DriverAction.markDelivered,
        DriverAction.hold,
        DriverAction.returnToBranch,
      });
    });
    test('terminal and unknown states expose no mutation, including Hold '
        'itself — there is no `hold -> anything` entry for a Driver', () {
      for (final status in [
        'hold',
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

  test('Customer contact accepts only centralized UAE format', () {
    expect(isSafeCustomerContact('+971 50 646 8441'), isTrue);
    expect(isSafeCustomerContact('javascript:alert(1)'), isFalse);
  });
}
