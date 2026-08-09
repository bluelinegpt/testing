import 'package:bluelinegpt_mobile/app/configuration/app_environment.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:bluelinegpt_mobile/features/trader/trader_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_repository.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_repository.dart';
import 'package:bluelinegpt_mobile/features/customer/customer_repository.dart';

final configurationProvider = Provider<AppConfiguration>(
  (ref) => AppConfiguration.fromDefines(),
);
final storageProvider = Provider<SensitiveStorage>(
  (ref) => SecureSensitiveStorage(),
);
final loggerProvider = Provider<AppLogger>(
  (ref) =>
      SafeAppLogger(verbose: ref.watch(configurationProvider).verboseLogging),
);
final notificationServiceProvider = Provider<NotificationService>(
  (ref) => SafeFirebaseNotificationService(ref.watch(loggerProvider)),
);
final apiClientProvider = Provider<ApiClient>((ref) {
  final storage = ref.watch(storageProvider);
  return ApiClient(
    baseUrl: ref.watch(configurationProvider).apiBaseUrl,
    tokenProvider: () => storage.read(SensitiveKey.accessToken),
  );
});
final authenticationApiProvider = Provider<AuthenticationApi>(
  (ref) => ApiAuthenticationApi(ref.watch(apiClientProvider)),
);
final deviceRegistrationProvider = Provider<DeviceRegistrationService>(
  (ref) => UnsupportedDeviceRegistrationService(),
);
final realtimeClientProvider = Provider<RealtimeClient>(
  (ref) => const UnsupportedRealtimeClient(),
);
final protectedCacheProvider = Provider<ProtectedCache>(
  (ref) => ScopedMemoryProtectedCache(),
);
final traderRepositoryProvider = Provider<TraderRepository>(
  (ref) => ApiTraderRepository(ref.watch(apiClientProvider)),
);
final driverRepositoryProvider = Provider<DriverRepository>(
  (ref) => ApiDriverRepository(ref.watch(apiClientProvider)),
);
final operatorRepositoryProvider = Provider<OperatorRepository>(
  (ref) => ApiOperatorRepository(ref.watch(apiClientProvider)),
);
final customerRepositoryProvider = Provider<CustomerRepository>(
  (ref) => ApiCustomerRepository(ref.watch(apiClientProvider)),
);
final authenticationServiceProvider = Provider<AuthenticationService>(
  (ref) => SessionAuthenticationService(
    storage: ref.watch(storageProvider),
    api: ref.watch(authenticationApiProvider),
    notifications: ref.watch(notificationServiceProvider),
    deviceRegistration: ref.watch(deviceRegistrationProvider),
    realtime: ref.watch(realtimeClientProvider),
    privateCache: ref.watch(protectedCacheProvider),
    errorMapper: const ApiErrorMapper(),
  ),
);

final class AuthenticationController
    extends AsyncNotifier<AuthenticationState> {
  @override
  Future<AuthenticationState> build() =>
      ref.read(authenticationServiceProvider).restore();

  Future<AuthenticationState> login(LoginInput input) async {
    if (state.isLoading) {
      return const AuthenticationState(AuthenticationStatus.checking);
    }
    state = const AsyncLoading();
    final result = await ref.read(authenticationServiceProvider).login(input);
    state = AsyncData(result);
    return result;
  }

  Future<void> logout() async {
    await ref.read(authenticationServiceProvider).logout();
    state = const AsyncData(AuthenticationState.unauthenticated());
  }

  Future<String?> changePassword(
    String currentPassword,
    String newPassword,
  ) async {
    final result = await ref
        .read(authenticationServiceProvider)
        .changePassword(currentPassword, newPassword);
    if (result == null) {
      state = AsyncData(
        await ref.read(authenticationServiceProvider).restore(),
      );
    }
    return result;
  }
}

final authenticationProvider =
    AsyncNotifierProvider<AuthenticationController, AuthenticationState>(
      AuthenticationController.new,
    );

final class LocaleController extends AsyncNotifier<Locale> {
  @override
  Future<Locale> build() async {
    final stored = await ref.read(storageProvider).read(SensitiveKey.locale);
    return Locale(stored == 'ar' ? 'ar' : 'en');
  }

  Future<void> change(Locale locale) async {
    await ref
        .read(storageProvider)
        .write(SensitiveKey.locale, locale.languageCode);
    state = AsyncData(locale);
  }
}

final localeProvider = AsyncNotifierProvider<LocaleController, Locale>(
  LocaleController.new,
);

final startupProvider = FutureProvider<void>((ref) async {
  await ref.read(authenticationProvider.future);
  await ref.read(localeProvider.future);
  await ref.read(notificationServiceProvider).initialize();
});

final offlineProvider = StreamProvider<bool>((ref) async* {
  final connectivity = Connectivity();
  final initial = await connectivity.checkConnectivity();
  yield initial.contains(ConnectivityResult.none);
  yield* connectivity.onConnectivityChanged.map(
    (results) => results.contains(ConnectivityResult.none),
  );
});
