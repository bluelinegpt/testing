import 'dart:convert';

import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'valid login verifies server identity, stores token, and connects services',
    () async {
      final fixture = _Fixture();
      final state = await fixture.service.login(
        const LoginInput(
          identifier: 'driver@example.com',
          password: 'password',
        ),
      );
      expect(state.isAuthenticated, isTrue);
      expect(state.user?.profileId, 'profile-1');
      expect(
        await fixture.storage.read(SensitiveKey.accessToken),
        'access-token',
      );
      expect(fixture.device.registered, 1);
      expect(fixture.realtime.connects, 1);
    },
  );

  test('empty login fails before calling backend', () async {
    final fixture = _Fixture();
    final state = await fixture.service.login(
      const LoginInput(identifier: '', password: ''),
    );
    expect(state.failureCode, 'required');
    expect(fixture.api.loginCalls, 0);
  });

  test('invalid credentials remain generic and clear token', () async {
    final fixture = _Fixture()
      ..api.loginError = const ApiFailure(
        ApiFailureKind.unauthorized,
        code: 'invalid_credentials',
      );
    final state = await fixture.service.login(
      const LoginInput(identifier: 'unknown', password: 'wrong'),
    );
    expect(state.failureCode, 'invalid_credentials');
    expect(await fixture.storage.read(SensitiveKey.accessToken), isNull);
  });

  test('invalid backend response fails closed', () async {
    final fixture = _Fixture()..api.loginResponse = {'unexpected': true};
    final state = await fixture.service.login(
      const LoginInput(identifier: 'user', password: 'password'),
    );
    expect(state.isAuthenticated, isFalse);
    expect(state.failureCode, ApiFailureKind.invalidResponse.name);
  });

  test('session restoration verifies server state', () async {
    final fixture = _Fixture();
    await fixture.seedSession();
    final state = await fixture.service.restore();
    expect(state.isAuthenticated, isTrue);
    expect(fixture.api.meCalls, 1);
  });

  test('expired session is cleared without backend trust', () async {
    final fixture = _Fixture();
    await fixture.seedSession(
      expiry: DateTime.now().toUtc().subtract(const Duration(minutes: 1)),
    );
    final state = await fixture.service.restore();
    expect(state.status, AuthenticationStatus.expired);
    expect(await fixture.storage.read(SensitiveKey.accessToken), isNull);
  });

  test('unknown role and missing Company are denied', () async {
    final unknown = _Fixture()..api.meResponse['kind'] = 'future_role';
    expect(
      (await unknown.service.login(
        const LoginInput(identifier: 'u', password: 'password'),
      )).failureCode,
      'unsupportedRole',
    );
    final missingCompany = _Fixture()..api.meResponse['companyId'] = null;
    expect(
      (await missingCompany.service.login(
        const LoginInput(identifier: 'u', password: 'password'),
      )).failureCode,
      'missingCompany',
    );
  });

  test('Trader and Driver missing profile relationships are denied', () async {
    final driver = _Fixture()..api.meResponse.remove('profileId');
    expect(
      (await driver.service.login(
        const LoginInput(identifier: 'u', password: 'password'),
      )).failureCode,
      'missingProfile',
    );
    final trader = _Fixture()
      ..api.meResponse['kind'] = 'trader'
      ..api.meResponse['profileType'] = 'trader'
      ..api.meResponse.remove('profileId');
    expect(
      (await trader.service.login(
        const LoginInput(identifier: 'u', password: 'password'),
      )).failureCode,
      'missingProfile',
    );
  });

  test(
    'logout revokes server and clears token, cache, device, and realtime',
    () async {
      final fixture = _Fixture();
      await fixture.service.login(
        const LoginInput(identifier: 'u', password: 'password'),
      );
      await fixture.service.logout();
      expect(fixture.api.logoutCalls, 1);
      expect(fixture.device.deregistered, 1);
      expect(fixture.realtime.disconnects, greaterThan(0));
      expect(await fixture.storage.read(SensitiveKey.accessToken), isNull);
    },
  );

  test(
    'optional device and realtime failures do not leak or block session',
    () async {
      final fixture = _Fixture()
        ..device.fail = true
        ..realtime.fail = true;
      final state = await fixture.service.login(
        const LoginInput(identifier: 'u', password: 'password'),
      );
      expect(state.isAuthenticated, isTrue);
      expect(state.user?.companyId, 'company-1');
    },
  );
}

final class _Fixture {
  _Fixture() {
    service = SessionAuthenticationService(
      storage: storage,
      api: api,
      notifications: notifications,
      deviceRegistration: device,
      realtime: realtime,
      privateCache: cache,
      errorMapper: const ApiErrorMapper(),
    );
  }
  final storage = MemorySensitiveStorage();
  final api = _FakeAuthApi();
  final notifications = _FakeNotifications();
  final device = _FakeDevice();
  final realtime = _FakeRealtime();
  final cache = ScopedMemoryProtectedCache();
  late final SessionAuthenticationService service;

  Future<void> seedSession({DateTime? expiry}) async {
    await storage.write(SensitiveKey.accessToken, 'access-token');
    await storage.write(
      SensitiveKey.sessionMetadata,
      jsonEncode({
        'expiresAt':
            (expiry ?? DateTime.now().toUtc().add(const Duration(hours: 1)))
                .toIso8601String(),
        'displayName': 'Driver One',
        'id': 'user-1',
        'companyId': 'company-1',
        'role': 'driver',
      }),
    );
  }
}

final class _FakeAuthApi implements AuthenticationApi {
  int loginCalls = 0;
  int meCalls = 0;
  int logoutCalls = 0;
  Object? loginError;
  Map<String, dynamic> loginResponse = {
    'accessToken': 'access-token',
    'expiresAt': DateTime.now()
        .toUtc()
        .add(const Duration(hours: 1))
        .toIso8601String(),
    'identity': {'displayName': 'Driver One', 'username': 'driver'},
  };
  Map<String, dynamic> meResponse = {
    'identityId': 'user-1',
    'companyId': 'company-1',
    'kind': 'driver',
    'permissions': <String>[],
    'profileId': 'profile-1',
    'profileType': 'driver',
  };
  @override
  Future<void> changePassword(
    String currentPassword,
    String newPassword,
  ) async {}
  @override
  Future<Map<String, dynamic>> login(LoginInput input) async {
    loginCalls++;
    if (loginError case final error?) throw error;
    return loginResponse;
  }

  @override
  Future<Map<String, dynamic>> currentIdentity() async {
    meCalls++;
    return meResponse;
  }

  @override
  Future<void> logout() async {
    logoutCalls++;
  }
}

final class _FakeNotifications implements NotificationService {
  @override
  Future<void> initialize() async {}
  @override
  Future<String?> token() async => 'fcm-token';
  @override
  Future<void> clearRegistration() async {}
}

final class _FakeDevice implements DeviceRegistrationService {
  int registered = 0;
  int deregistered = 0;
  bool fail = false;
  @override
  Future<void> register(String token, AuthenticatedUser user) async {
    registered++;
    if (fail) throw StateError('offline');
  }

  @override
  Future<void> deregister() async {
    deregistered++;
  }
}

final class _FakeRealtime implements RealtimeClient {
  int connects = 0;
  int disconnects = 0;
  bool fail = false;
  @override
  Stream<RealtimeState> get states => const Stream.empty();
  @override
  Future<void> connect({
    required String accessToken,
    required String companyId,
  }) async {
    connects++;
    if (fail) throw StateError('offline');
  }

  @override
  Future<void> disconnect() async {
    disconnects++;
  }

  @override
  Future<void> subscribeToConversation(String conversationId) async {}
}
