import 'package:bluelinegpt_mobile/core/validation/safe_parsers.dart';

final class TraderArea {
  const TraderArea({
    required this.id,
    required this.emirateId,
    required this.nameEn,
    required this.emirateNameEn,
    this.nameAr,
    this.emirateNameAr,
  });
  final String id;
  final String emirateId;
  final String nameEn;
  final String? nameAr;
  final String emirateNameEn;
  final String? emirateNameAr;
}

final class TraderOrder {
  const TraderOrder({
    required this.id,
    required this.orderNumber,
    required this.orderDate,
    required this.areaId,
    required this.areaName,
    required this.customerName,
    required this.customerMobile,
    required this.address,
    required this.cod,
    required this.serviceFee,
    required this.netExpected,
    required this.status,
    this.reference,
    this.notes,
  });
  final String id;
  final String orderNumber;
  final String orderDate;
  final String areaId;
  final String areaName;
  final String customerName;
  final String customerMobile;
  final String address;
  final String cod;
  final String serviceFee;
  final String? netExpected;
  final String status;
  final String? reference;
  final String? notes;
}

final class TraderOrderDraft {
  const TraderOrderDraft({
    required this.customerName,
    required this.customerMobile,
    required this.areaId,
    required this.address,
    required this.cod,
    this.reference,
    this.notes,
  });
  final String customerName;
  final String customerMobile;
  final String areaId;
  final String address;
  final String cod;
  final String? reference;
  final String? notes;

  Map<String, String> validate() {
    final errors = <String, String>{};
    if (customerName.trim().isEmpty || customerName.trim().length > 160) {
      errors['customerName'] = 'invalid';
    }
    if (!UaeMobileValidator.isValid(customerMobile)) {
      errors['customerMobile'] = 'invalid';
    }
    if (areaId.isEmpty) errors['areaId'] = 'required';
    if (address.trim().isEmpty || address.trim().length > 500) {
      errors['address'] = 'invalid';
    }
    if (!SafeNumberParser.parse(cod).isValid) errors['cod'] = 'invalid';
    final trimmedReference = reference?.trim();
    if (trimmedReference != null &&
        (trimmedReference.isEmpty ||
            trimmedReference.length > 160 ||
            !RegExp(
              r'^[\p{L}\p{N}_\-/ ]+$',
              unicode: true,
            ).hasMatch(trimmedReference))) {
      errors['reference'] = 'invalid';
    }
    if ((notes?.length ?? 0) > 1000) errors['notes'] = 'invalid';
    return errors;
  }

  String? get normalizedReference => reference?.trim();
}

final class TraderPricingPreview {
  const TraderPricingPreview({
    required this.cod,
    required this.deliveryFee,
    required this.netExpected,
    required this.version,
  });
  final String cod;
  final String deliveryFee;
  final String netExpected;
  final String version;
}

bool locallyCancellable(String status) =>
    status == 'new' || status == 'assigned_to_driver' || status == 'assigned';

bool pricingChanged(TraderPricingPreview previous, TraderPricingPreview next) =>
    previous.version != next.version ||
    previous.cod != next.cod ||
    previous.deliveryFee != next.deliveryFee ||
    previous.netExpected != next.netExpected;

final class TraderSubmissionGuard {
  TraderSubmissionGuard(this.idempotencyKey);
  final String idempotencyKey;
  bool _submitting = false;
  bool get isSubmitting => _submitting;
  bool begin() {
    if (_submitting) return false;
    _submitting = true;
    return true;
  }

  void finish() => _submitting = false;
}
