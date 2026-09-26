import 'package:bluelinegpt_mobile/features/customer/customer_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('tracking token requires exact high-entropy URL-safe shape', () {
    String token(int length) => List.filled(length, 'A').join();
    expect(isValidTrackingToken(token(43)), isTrue);
    expect(isValidTrackingToken(token(42)), isFalse);
    expect(isValidTrackingToken('../${token(40)}'), isFalse);
    expect(isValidTrackingToken(token(44)), isFalse);
  });
  test('approved statuses map to Customer-safe presentation', () {
    expect(customerStatus('new'), CustomerOrderStatus.received);
    expect(customerStatus('assigned_to_driver'), CustomerOrderStatus.assigned);
    expect(
      customerStatus('out_for_delivery'),
      CustomerOrderStatus.outForDelivery,
    );
    expect(customerStatus('delivered'), CustomerOrderStatus.delivered);
    expect(customerStatus('hold'), CustomerOrderStatus.deliveryIssue);
    expect(
      customerStatus('returned_to_branch'),
      CustomerOrderStatus.returnedToBranch,
    );
    expect(
      customerStatus('returned_to_trader'),
      CustomerOrderStatus.returnedToTrader,
    );
    expect(customerStatus('cancelled'), CustomerOrderStatus.cancelled);
  });
  test('unknown and internal-only statuses fail safely', () {
    for (final status in [
      'processing',
      'closed',
      'reconciled',
      'money_sent',
      'unexpected',
    ]) {
      expect(customerStatus(status), CustomerOrderStatus.updating);
    }
  });
  test('Customer-safe DTO has no finance, Driver contact, or audit fields', () {
    const summary = CustomerTrackingSummary(
      companyName: 'BlueLine',
      orderNumber: 'BL-1',
      customerName: 'Customer',
      areaName: 'Dubai',
      status: CustomerOrderStatus.received,
      lastUpdatedAt: '2026-08-01',
    );
    expect(summary.orderNumber, 'BL-1');
    expect(summary.toString(), isNot(contains('settlement')));
  });
}
