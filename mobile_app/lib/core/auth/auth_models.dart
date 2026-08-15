import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
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
    this.linkedDriverId,
    this.companyName,
    this.companyNameAr,
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

  /// The authenticated Company's display name — sourced from `/auth/me`
  /// (`companyName`/`companyNameAr`, `companies.name_en`/`name_ar`), never
  /// guessed or cached locally. `null` for a Platform Administrator (no
  /// Company) or a Customer account.
  final String? companyName;
  final String? companyNameAr;

  /// Present only for a `company_user` ("Driver User") whose linked Employee
  /// backs a `drivers.employee_id` record — the backend's single
  /// authoritative signal for this (`/auth/me`'s `linkedDriverId`, sourced
  /// from `OperationsService.currentEmployeeDriverId()`/
  /// `AuthenticationRepository.linkedDriverId()`). `null` for every other
  /// identity, including a plain Operator and a genuine `driver`-kind
  /// account (which doesn't need the hint — `roles` already says `driver`).
  /// Never inferred from display name, username, or any hardcoded account.
  final String? linkedDriverId;

  bool can(String permission) => permissions.contains(permission);
  bool hasRole(UserRole role) => roles.contains(role);
  bool get isAuthorized => accessState == AccountAccessState.active;

  /// The single place that decides "show this account a Driver-style UI" —
  /// true for a genuine `driver`-kind account, and equally true for a Driver
  /// User (a `company_user` whose `linkedDriverId` resolved). Every other
  /// place (dashboard, profile, router, order detail) must read this getter
  /// rather than re-deriving the same decision independently.
  bool get isDriverPresentation =>
      hasRole(UserRole.driver) || linkedDriverId != null;
}

/// The Company's display name in the viewer's locale — Arabic when available
/// and the app is in Arabic, English otherwise, `null` only when the account
/// genuinely has no Company (Platform Administrator/Customer) or the backend
/// hasn't sent one. Never fabricated — the same "show nothing rather than a
/// wrong guess" convention `driver_order_detail_view.dart`'s emirate-name
/// locale selection already uses.
String? companyDisplayName(AuthenticatedUser user, String locale) {
  final nameAr = user.companyNameAr?.trim();
  final nameEn = user.companyName?.trim();
  final preferred = locale == 'ar' ? nameAr : nameEn;
  if (preferred != null && preferred.isNotEmpty) return preferred;
  final fallback = locale == 'ar' ? nameEn : nameAr;
  return (fallback != null && fallback.isNotEmpty) ? fallback : null;
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

/// The single shared role-label mapping — previously duplicated
/// byte-for-byte between `dashboard_page.dart` and `pages.dart`'s
/// `AccountPage`. `isDriverPresentation` covers BOTH a genuine `driver`-kind
/// account and a Driver User (`company_user` + resolved `linkedDriverId`),
/// so Profile/Dashboard authoritatively read "Driver" for a Driver User with
/// zero hardcoding on display name, username, or any specific account.
String roleLabel(AuthenticatedUser user, AppLocalizations l10n) {
  if (user.hasRole(UserRole.trader)) return l10n.trader;
  if (user.isDriverPresentation) return l10n.driver;
  if (user.hasRole(UserRole.operatorRole)) return l10n.operator;
  if (user.hasRole(UserRole.customer)) return l10n.customer;
  return l10n.unsupportedRole;
}
