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

  group('Customer contact', () {
    test('accepts every common way of typing a UAE mobile number', () {
      for (final raw in [
        '+971 50 646 8441',
        '0506468441',
        '506468441',
        '971506468441',
        '00971506468441',
        '050-646-8441',
        '٠٥٠٦٤٦٨٤٤١',
      ]) {
        expect(customerMobileE164(raw), '+971506468441', reason: raw);
        expect(isSafeCustomerContact(raw), isTrue, reason: raw);
      }
    });

    test('refuses anything that is not a UAE mobile number', () {
      for (final raw in [
        'javascript:alert(1)',
        '0507768',
        '043334444',
        '0516468441',
        '',
        '+44 7700 900123',
      ]) {
        expect(customerMobileE164(raw), isNull, reason: raw);
        expect(customerCallUri(raw), isNull, reason: raw);
        expect(customerWhatsAppUri(raw, 'hi'), isNull, reason: raw);
        expect(customerSmsUri(raw, 'hi'), isNull, reason: raw);
      }
    });

    test('builds call, WhatsApp and SMS links with the message unsent', () {
      const message = 'Hello Ali, order 6060.';
      expect(customerCallUri('0506468441').toString(), 'tel:+971506468441');
      expect(
        customerWhatsAppUri('0506468441', message).toString(),
        'https://wa.me/971506468441?text=Hello%20Ali%2C%20order%206060.',
      );
      expect(
        customerSmsUri('0506468441', message).toString(),
        'sms:+971506468441?body=Hello%20Ali%2C%20order%206060.',
      );
    });

    test('encodes an Arabic message safely', () {
      final uri = customerWhatsAppUri('0506468441', 'مرحباً علي');
      expect(Uri.decodeComponent(uri!.query.substring(5)), 'مرحباً علي');
    });
  });

  group('Open Map', () {
    String? query(Uri? uri) => uri?.queryParameters['query'];

    test('searches the address inside its Area and Emirate', () {
      expect(
        query(
          orderMapUri(address: 'dd', areaName: 'الباهية', emirateName: 'Ajman'),
        ),
        'dd, الباهية, Ajman, UAE',
      );
    });

    test('falls back to the Area when there is no address', () {
      expect(
        query(
          orderMapUri(address: ' ', areaName: 'الباهية', emirateName: 'Ajman'),
        ),
        'الباهية, Ajman, UAE',
      );
    });

    test('is unavailable with neither an address nor an Area', () {
      expect(orderMapUri(address: '', areaName: ''), isNull);
    });
  });
}
