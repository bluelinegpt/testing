import 'package:flutter/foundation.dart';

@immutable
final class UserRole {
  const UserRole(this.code);
  final String code;
  static const trader = UserRole('trader');
  static const driver = UserRole('driver');
  static const operatorRole = UserRole('operator');
  static const customer = UserRole('customer');

  @override
  bool operator ==(Object other) => other is UserRole && other.code == code;
  @override
  int get hashCode => code.hashCode;
}

enum AccountAccessState {
  active,
  unsupportedRole,
  unauthorized,
  deactivated,
  locked,
  incomplete,
  missingCompany,
  missingProfile,
  expired,
}

@immutable
final class AuthenticatedUser {
  const AuthenticatedUser({
    required this.id,
    required this.companyId,
    required this.displayName,
    required this.roles,
    required this.permissions,
    required this.accessState,
    this.profileId,
    this.profileType,
    this.forcePasswordChange = false,
  });
  final String id;
  final String companyId;
  final String displayName;
  final Set<UserRole> roles;
  final Set<String> permissions;
  final AccountAccessState accessState;
  final String? profileId;
  final String? profileType;
  final bool forcePasswordChange;

  bool can(String permission) => permissions.contains(permission);
  bool hasRole(UserRole role) => roles.contains(role);
  bool get isAuthorized => accessState == AccountAccessState.active;
}

@immutable
final class AuthenticatedSession {
  const AuthenticatedSession({required this.user, required this.expiresAt});
  final AuthenticatedUser user;
  final DateTime expiresAt;
  bool get isExpired => !expiresAt.isAfter(DateTime.now().toUtc());
}

enum AuthenticationStatus {
  checking,
  authenticated,
  unauthenticated,
  expired,
  deactivated,
  locked,
  unauthorized,
}

@immutable
final class AuthenticationState {
  const AuthenticationState(
    this.status, {
    this.session,
    this.failureCode,
    this.failureKind,
    this.failureStatus,
  });
  const AuthenticationState.unauthenticated()
    : this(AuthenticationStatus.unauthenticated);
  final AuthenticationStatus status;
  final AuthenticatedSession? session;
  final String? failureCode;
  final String? failureKind;
  final int? failureStatus;
  AuthenticatedUser? get user => session?.user;
  bool get isAuthenticated =>
      status == AuthenticationStatus.authenticated &&
      session != null &&
      session!.user.isAuthorized;
}

final class LoginInput {
  const LoginInput({required this.identifier, required this.password});
  final String identifier;
  final String password;
  bool get isValid => identifier.trim().isNotEmpty && password.isNotEmpty;
}
