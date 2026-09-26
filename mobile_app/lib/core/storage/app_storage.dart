import 'package:flutter_secure_storage/flutter_secure_storage.dart';

enum SensitiveKey {
  accessToken('access_token'),
  refreshToken('refresh_token'),
  userId('user_id'),
  companyId('company_id'),
  sessionMetadata('session_metadata'),
  locale('locale'),
  deviceRegistrationId('device_registration_id'),
  // Device-level push-notification permission UX state (Prompt 15) — not
  // session data, so (like `locale`) it survives `clearSession()` and is
  // never cleared on logout.
  notificationPermissionAsked('notification_permission_asked'),
  notificationPermissionDenialCount('notification_permission_denial_count'),
  // The six-digit Company Mobile Code chosen at first launch. Device-level
  // like `locale`: it identifies WHICH Company this installation belongs to,
  // not who is signed in, so logout and failed logins must not erase it —
  // a Driver who signs out should not have to re-scan the Company QR.
  companyMobileCode('company_mobile_code');

  const SensitiveKey(this.value);
  final String value;
}

abstract interface class SensitiveStorage {
  Future<String?> read(SensitiveKey key);
  Future<void> write(SensitiveKey key, String value);
  Future<void> delete(SensitiveKey key);
  Future<void> clearSession();
}

final class SecureSensitiveStorage implements SensitiveStorage {
  SecureSensitiveStorage([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(SensitiveKey key) => _storage.read(key: key.value);

  @override
  Future<void> write(SensitiveKey key, String value) =>
      _storage.write(key: key.value, value: value);

  @override
  Future<void> delete(SensitiveKey key) => _storage.delete(key: key.value);

  @override
  Future<void> clearSession() async {
    for (final key in SensitiveKey.values.where(
      (key) =>
          key != SensitiveKey.locale &&
          key != SensitiveKey.notificationPermissionAsked &&
          key != SensitiveKey.notificationPermissionDenialCount &&
          key != SensitiveKey.companyMobileCode,
    )) {
      await delete(key);
    }
  }
}

final class MemorySensitiveStorage implements SensitiveStorage {
  final Map<SensitiveKey, String> values = {};

  @override
  Future<void> clearSession() async {
    values.removeWhere(
      (key, _) =>
          key != SensitiveKey.locale &&
          key != SensitiveKey.notificationPermissionAsked &&
          key != SensitiveKey.notificationPermissionDenialCount &&
          key != SensitiveKey.companyMobileCode,
    );
  }

  @override
  Future<void> delete(SensitiveKey key) async => values.remove(key);

  @override
  Future<String?> read(SensitiveKey key) async => values[key];

  @override
  Future<void> write(SensitiveKey key, String value) async =>
      values[key] = value;
}
