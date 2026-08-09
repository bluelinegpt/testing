import 'dart:convert';

import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';

abstract interface class AuthenticationApi {
  Future<Map<String, dynamic>> login(LoginInput input);
  Future<Map<String, dynamic>> currentIdentity();
  Future<void> logout();
  Future<void> changePassword(String currentPassword, String newPassword);
}

final class ApiAuthenticationApi implements AuthenticationApi {
  ApiAuthenticationApi(this.client);
  final ApiClient client;
  @override
  Future<Map<String, dynamic>> login(LoginInput input) async => _object(
    (await client.post<Object?>(
      'auth/login',
      data: {'identifier': input.identifier.trim(), 'password': input.password},
    )).data,
  );
  @override
  Future<Map<String, dynamic>> currentIdentity() async =>
      _object((await client.get<Object?>('auth/me')).data);
  @override
  Future<void> logout() async => client.post<void>('auth/logout');
  @override
  Future<void> changePassword(
    String currentPassword,
    String newPassword,
  ) async {
    await client.post<void>(
      'auth/change-password',
      data: {'currentPassword': currentPassword, 'newPassword': newPassword},
    );
  }

  static Map<String, dynamic> _object(Object? value) {
    if (value is! Map) throw const ApiFailure(ApiFailureKind.invalidResponse);
    return Map<String, dynamic>.from(value);
  }
}

abstract interface class AuthenticationService {
  Future<AuthenticationState> login(LoginInput input);
  Future<AuthenticationState> restore();
  Future<void> logout();
  Future<String?> changePassword(String currentPassword, String newPassword);
}

final class SessionAuthenticationService implements AuthenticationService {
  SessionAuthenticationService({
    required this.storage,
    required this.api,
    required this.notifications,
    required this.deviceRegistration,
    required this.realtime,
    required this.privateCache,
    required this.errorMapper,
  });
  final SensitiveStorage storage;
  final AuthenticationApi api;
  final NotificationService notifications;
  final DeviceRegistrationService deviceRegistration;
  final RealtimeClient realtime;
  final ProtectedCache privateCache;
  final ApiErrorMapper errorMapper;

  @override
  Future<AuthenticationState> login(LoginInput input) async {
    if (!input.isValid) {
      return const AuthenticationState(
        AuthenticationStatus.unauthenticated,
        failureCode: 'required',
      );
    }
    try {
      final response = await api.login(input);
      final token = response['accessToken'];
      final expiresAt = DateTime.tryParse(
        response['expiresAt']?.toString() ?? '',
      )?.toUtc();
      final loginIdentity = response['identity'];
      if (token is! String ||
          token.isEmpty ||
          expiresAt == null ||
          loginIdentity is! Map) {
        throw const ApiFailure(ApiFailureKind.invalidResponse);
      }
      await storage.write(SensitiveKey.accessToken, token);
      final verified = await api.currentIdentity();
      final session = _sessionFrom(response, verified, expiresAt);
      if (!session.user.isAuthorized || session.isExpired) {
        await _localCleanup(session.user);
        return AuthenticationState(
          _statusFor(session.user.accessState),
          failureCode: session.user.accessState.name,
        );
      }
      await _persistMetadata(session);
      await _connectOptionalServices(session);
      return AuthenticationState(
        AuthenticationStatus.authenticated,
        session: session,
      );
    } on Object catch (error) {
      await storage.clearSession();
      final failure = error is ApiFailure ? error : errorMapper.map(error);
      return AuthenticationState(
        AuthenticationStatus.unauthenticated,
        failureCode: failure.code ?? failure.kind.name,
        failureKind: failure.kind.name,
        failureStatus: failure.statusCode,
      );
    }
  }

  @override
  Future<AuthenticationState> restore() async {
    try {
      final token = await storage.read(SensitiveKey.accessToken);
      final raw = await storage.read(SensitiveKey.sessionMetadata);
      if (token == null || raw == null) {
        return const AuthenticationState.unauthenticated();
      }
      final metadata = jsonDecode(raw);
      if (metadata is! Map<String, dynamic>) throw const FormatException();
      final expiresAt = DateTime.tryParse(
        metadata['expiresAt']?.toString() ?? '',
      )?.toUtc();
      if (expiresAt == null || !expiresAt.isAfter(DateTime.now().toUtc())) {
        await storage.clearSession();
        return const AuthenticationState(AuthenticationStatus.expired);
      }
      final verified = await api.currentIdentity();
      final session = _sessionFrom(metadata, verified, expiresAt);
      if (!session.user.isAuthorized) {
        await _localCleanup(session.user);
        return AuthenticationState(_statusFor(session.user.accessState));
      }
      await _connectOptionalServices(session);
      return AuthenticationState(
        AuthenticationStatus.authenticated,
        session: session,
      );
    } on Object {
      await storage.clearSession();
      return const AuthenticationState.unauthenticated();
    }
  }

  @override
  Future<void> logout() async {
    AuthenticatedUser? user;
    try {
      final raw = await storage.read(SensitiveKey.sessionMetadata);
      if (raw != null) {
        final data = jsonDecode(raw) as Map<String, dynamic>;
        user = _localUser(data);
      }
    } on Object {
      /* corrupted local metadata is ignored */
    }
    try {
      await api.logout();
    } on Object {
      /* local logout must still succeed */
    }
    try {
      await deviceRegistration.deregister();
    } on Object {
      /* optional */
    }
    try {
      await notifications.clearRegistration();
    } on Object {
      /* optional */
    }
    try {
      await realtime.disconnect();
    } on Object {
      /* optional */
    }
    if (user != null) await privateCache.clear(user.companyId, user.id);
    await storage.clearSession();
  }

  @override
  Future<String?> changePassword(
    String currentPassword,
    String newPassword,
  ) async {
    if (currentPassword.length < 8 || newPassword.length < 8) {
      return 'password_length';
    }
    try {
      await api.changePassword(currentPassword, newPassword);
      return null;
    } on Object catch (error) {
      final failure = error is ApiFailure ? error : errorMapper.map(error);
      return failure.code ?? failure.kind.name;
    }
  }

  AuthenticatedSession _sessionFrom(
    Map<dynamic, dynamic> login,
    Map<String, dynamic> verified,
    DateTime expiry,
  ) {
    final identity = login['identity'] is Map
        ? Map<String, dynamic>.from(login['identity'] as Map)
        : Map<String, dynamic>.from(login);
    final id = verified['identityId'];
    final companyId = verified['companyId'];
    final kind = verified['kind'];
    final permissions = verified['permissions'];
    final displayName = identity['displayName'] ?? identity['username'];
    final role = _roleFor(kind);
    var access = AccountAccessState.active;
    if (id is! String || displayName is! String || permissions is! List) {
      access = AccountAccessState.incomplete;
    }
    if (companyId is! String || companyId.isEmpty) {
      access = AccountAccessState.missingCompany;
    }
    if (role == null) access = AccountAccessState.unsupportedRole;
    final profileId = verified['profileId'] as String?;
    final profileType = verified['profileType'] as String?;
    if ((role == UserRole.trader || role == UserRole.driver) &&
        (profileId == null || profileType != role!.code)) {
      access = AccountAccessState.missingProfile;
    }
    if (role == UserRole.operatorRole &&
        permissions is List &&
        permissions.isEmpty) {
      access = AccountAccessState.unauthorized;
    }
    return AuthenticatedSession(
      expiresAt: expiry,
      user: AuthenticatedUser(
        id: id is String ? id : '',
        companyId: companyId is String ? companyId : '',
        displayName: displayName is String ? displayName : '',
        roles: role == null ? const {} : {role},
        permissions: permissions is List
            ? permissions.whereType<String>().toSet()
            : const {},
        accessState: access,
        profileId: profileId,
        profileType: profileType,
        forcePasswordChange:
            verified['forcePasswordChange'] == true ||
            identity['forcePasswordChange'] == true,
      ),
    );
  }

  UserRole? _roleFor(Object? kind) => switch (kind) {
    'trader' => UserRole.trader,
    'driver' => UserRole.driver,
    'company_user' => UserRole.operatorRole,
    'customer' => UserRole.customer,
    _ => null,
  };

  AuthenticationStatus _statusFor(AccountAccessState state) => switch (state) {
    AccountAccessState.expired => AuthenticationStatus.expired,
    AccountAccessState.deactivated => AuthenticationStatus.deactivated,
    AccountAccessState.locked => AuthenticationStatus.locked,
    _ => AuthenticationStatus.unauthorized,
  };

  Future<void> _persistMetadata(AuthenticatedSession session) async {
    final user = session.user;
    await storage.write(SensitiveKey.userId, user.id);
    await storage.write(SensitiveKey.companyId, user.companyId);
    await storage.write(
      SensitiveKey.sessionMetadata,
      jsonEncode({
        'expiresAt': session.expiresAt.toIso8601String(),
        'displayName': user.displayName,
        'id': user.id,
        'companyId': user.companyId,
        'role': user.roles.first.code,
        'profileId': user.profileId,
        'profileType': user.profileType,
      }),
    );
  }

  AuthenticatedUser _localUser(Map<String, dynamic> value) => AuthenticatedUser(
    id: value['id']?.toString() ?? '',
    companyId: value['companyId']?.toString() ?? '',
    displayName: value['displayName']?.toString() ?? '',
    roles: const {},
    permissions: const {},
    accessState: AccountAccessState.incomplete,
  );

  Future<void> _connectOptionalServices(AuthenticatedSession session) async {
    try {
      final token = await notifications.token();
      if (token != null) await deviceRegistration.register(token, session.user);
    } on Object {
      /* notification failure must not block login */
    }
    try {
      final accessToken = await storage.read(SensitiveKey.accessToken);
      if (accessToken != null) {
        await realtime.connect(
          accessToken: accessToken,
          companyId: session.user.companyId,
        );
      }
    } on Object {
      /* real-time failure must not block login */
    }
  }

  Future<void> _localCleanup(AuthenticatedUser user) async {
    await privateCache.clear(user.companyId, user.id);
    await realtime.disconnect();
    await storage.clearSession();
  }
}
