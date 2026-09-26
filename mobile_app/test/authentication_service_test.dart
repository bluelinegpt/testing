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

  test(
    'no stored session restores as unauthenticated (Login is shown)',
    () async {
      final fixture = _Fixture();
      final state = await fixture.service.restore();
      expect(state.isAuthenticated, isFalse);
      expect(state.status, AuthenticationStatus.unauthenticated);
      // No local session material means no backend round trip is even
      // attempted — nothing exists yet to verify.
      expect(fixture.api.meCalls, 0);
    },
  );

  test('session restoration verifies server state and re-registers the device '
      'push token (Prompt 15 — a cold-start restore must not silently skip '
      'registration)', () async {
    final fixture = _Fixture();
    await fixture.seedSession();
    final state = await fixture.service.restore();
    expect(state.isAuthenticated, isTrue);
    expect(fixture.api.meCalls, 1);
    expect(fixture.device.registered, 1);
  });

  test(
    'a revoked or disabled account is denied on restore and local data is cleared '
    '(mobile Login enhancement — restore never trusts local data alone)',
    () async {
      final fixture = _Fixture();
      await fixture.seedSession();
      // The backend is the single source of truth for account state: a
      // revoked session or a disabled user/Company surfaces as the identity
      // check failing, not as a locally-cached flag.
      fixture.api.meError = const ApiFailure(
        ApiFailureKind.unauthorized,
        code: 'account_disabled',
      );
      final state = await fixture.service.restore();
      expect(state.isAuthenticated, isFalse);
      expect(state.status, AuthenticationStatus.unauthenticated);
      expect(await fixture.storage.read(SensitiveKey.accessToken), isNull);
      expect(await fixture.storage.read(SensitiveKey.sessionMetadata), isNull);
    },
  );

  test(
    'a disabled Company denies restore and clears local session material',
    () async {
      final fixture = _Fixture();
      await fixture.seedSession();
      fixture.api.meResponse['companyId'] = null;
      final state = await fixture.service.restore();
      expect(state.isAuthenticated, isFalse);
      expect(state.status, AuthenticationStatus.unauthorized);
      expect(await fixture.storage.read(SensitiveKey.accessToken), isNull);
    },
  );

  test(
    'restored session uses the role and Company the backend verifies now, '
    'never a stale locally-cached value (mobile Login enhancement)',
    () async {
      final fixture = _Fixture();
      // Local metadata claims a stale role and a different Company than the
      // backend currently reports — simulating data left over from before a
      // role/Company change, or tampering with the on-device cache.
      await fixture.seedSession(role: 'trader', companyId: 'stale-company');
      fixture.api.meResponse
        ..['kind'] = 'driver'
        ..['companyId'] = 'fresh-company'
        ..['profileId'] = 'profile-1'
        ..['profileType'] = 'driver';
      final state = await fixture.service.restore();
      expect(state.isAuthenticated, isTrue);
      expect(state.user?.roles, {UserRole.driver});
      expect(state.user?.companyId, 'fresh-company');
    },
  );

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

  test('a failing server logout call (network unavailable) still clears local '
      'session material — local logout must always succeed', () async {
    final fixture = _Fixture()
      ..api.logoutError = const ApiFailure(ApiFailureKind.network);
    await fixture.service.login(
      const LoginInput(identifier: 'u', password: 'password'),
    );
    await fixture.service.logout();
    expect(await fixture.storage.read(SensitiveKey.accessToken), isNull);
    expect(await fixture.storage.read(SensitiveKey.sessionMetadata), isNull);
  });

  test(
    'a failing push-deregistration call still logs out and clears local '
    'session material (best-effort, like every other optional logout step)',
    () async {
      final fixture = _Fixture()..device.failDeregister = true;
      await fixture.service.login(
        const LoginInput(identifier: 'u', password: 'password'),
      );
      await fixture.service.logout();
      expect(await fixture.storage.read(SensitiveKey.accessToken), isNull);
    },
  );

  test('logout clears the Driver offline store for the logging-out identity '
      '(Prompt 16 §T)', () async {
    final fixture = _Fixture();
    await fixture.service.login(
      const LoginInput(identifier: 'u', password: 'password'),
    );
    await fixture.service.logout();
    expect(fixture.offlineStore.clearedScopes, [
      (userId: 'user-1', companyId: 'company-1'),
    ]);
  });

  test('a failing Driver offline store never blocks logout (best-effort, like '
      'every other optional logout step)', () async {
    final fixture = _Fixture()..offlineStore.fail = true;
    await fixture.service.login(
      const LoginInput(identifier: 'u', password: 'password'),
    );
    await fixture.service.logout();
    expect(await fixture.storage.read(SensitiveKey.accessToken), isNull);
  });

  test('restarting the app after logout does not auto-login — restore sees no '
      'session and Login is shown again (mobile Login enhancement)', () async {
    final fixture = _Fixture();
    await fixture.service.login(
      const LoginInput(identifier: 'u', password: 'password'),
    );
    await fixture.service.logout();
    final meCallsBeforeRestore = fixture.api.meCalls;
    // The same durable storage a real app restart would read from — since
    // logout already cleared it, restore() must not resurrect a session,
    // and (with nothing local left to verify) must not even call the
    // backend again.
    final state = await fixture.service.restore();
    expect(state.isAuthenticated, isFalse);
    expect(state.status, AuthenticationStatus.unauthenticated);
    expect(fixture.api.meCalls, meCallsBeforeRestore);
  });

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
      driverOfflineStore: offlineStore,
    );
  }
  final storage = MemorySensitiveStorage();
  final api = _FakeAuthApi();
  final notifications = _FakeNotifications();
  final device = _FakeDevice();
  final realtime = _FakeRealtime();
  final cache = ScopedMemoryProtectedCache();
  final offlineStore = _FakeOfflineStore();
  late final SessionAuthenticationService service;

  Future<void> seedSession({
    DateTime? expiry,
    String role = 'driver',
    String companyId = 'company-1',
  }) async {
    await storage.write(SensitiveKey.accessToken, 'access-token');
    await storage.write(
      SensitiveKey.sessionMetadata,
      jsonEncode({
        'expiresAt':
            (expiry ?? DateTime.now().toUtc().add(const Duration(hours: 1)))
                .toIso8601String(),
        'displayName': 'Driver One',
        'id': 'user-1',
        'companyId': companyId,
        'role': role,
      }),
    );
  }
}

final class _FakeAuthApi implements AuthenticationApi {
  int loginCalls = 0;
  int meCalls = 0;
  int logoutCalls = 0;
  Object? loginError;
  Object? meError;
  Object? logoutError;
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
    if (meError case final error?) throw error;
    return meResponse;
  }

  @override
  Future<void> logout() async {
    logoutCalls++;
    if (logoutError case final error?) throw error;
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
  bool failDeregister = false;
  @override
  Future<void> register(String token, AuthenticatedUser user) async {
    registered++;
    if (fail) throw StateError('offline');
  }

  @override
  Future<void> deregister() async {
    deregistered++;
    if (failDeregister) throw StateError('offline');
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

final class _FakeOfflineStore implements OfflineStore {
  bool fail = false;
  final List<({String userId, String companyId})> clearedScopes = [];
  @override
  Future<void> clearScope({
    required String userId,
    required String companyId,
  }) async {
    if (fail) throw StateError('offline store unavailable');
    clearedScopes.add((userId: userId, companyId: companyId));
  }
}
