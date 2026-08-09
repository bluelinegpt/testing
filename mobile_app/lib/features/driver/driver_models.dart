import 'package:bluelinegpt_mobile/core/validation/safe_parsers.dart';

final class DriverOrder {
  const DriverOrder({
    required this.id,
    required this.orderNumber,
    required this.orderDate,
    required this.areaId,
    required this.areaName,
    required this.customerName,
    required this.customerMobile,
    required this.address,
    required this.expectedCod,
    required this.amountCollected,
    required this.status,
    this.reference,
    this.notes,
  });
  final String id,
      orderNumber,
      orderDate,
      areaId,
      areaName,
      customerName,
      customerMobile,
      address,
      expectedCod,
      amountCollected,
      status;
  final String? reference, notes;
}

enum DriverAction { startDelivery, markDelivered, reportFailure }

Set<DriverAction> actionsForDriverStatus(String status) => switch (status) {
  'assigned_to_driver' || 'assigned' => {DriverAction.startDelivery},
  'out_for_delivery' => {
    DriverAction.markDelivered,
    DriverAction.reportFailure,
  },
  _ => const {},
};

enum DriverPaymentMethod { cash, bank }

final class DeliveryConfirmationDraft {
  const DeliveryConfirmationDraft({
    required this.expectedCod,
    required this.actualCod,
    required this.paymentMethod,
    this.bankReference,
    this.notes,
  });
  final String expectedCod, actualCod;
  final DriverPaymentMethod paymentMethod;
  final String? bankReference, notes;
  Map<String, String> validate() {
    final errors = <String, String>{};
    final expected = SafeNumberParser.parse(expectedCod);
    final actual = SafeNumberParser.parse(actualCod);
    if (!expected.isValid || !actual.isValid) {
      errors['actualCod'] = 'invalid';
    }
    if (expected.value != actual.value) {
      errors['actualCod'] = 'difference_unsupported';
    }
    if (paymentMethod == DriverPaymentMethod.bank &&
        (bankReference?.trim().isEmpty ?? true)) {
      errors['bankReference'] = 'required';
    }
    if ((bankReference?.trim().length ?? 0) > 80) {
      errors['bankReference'] = 'invalid';
    }
    if ((notes?.length ?? 0) > 300) errors['notes'] = 'invalid';
    return errors;
  }
}

bool isSafeCustomerContact(String value) => UaeMobileValidator.isValid(value);
