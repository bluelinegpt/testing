import 'package:bluelinegpt_mobile/app/configuration/app_environment.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:bluelinegpt_mobile/features/notifications/notifications_repository.dart';
import 'package:bluelinegpt_mobile/features/trader/trader_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_cache_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_offline_repository.dart';
import 'package:bluelinegpt_mobile/features/driver/driver_sync_queue_repository.dart';
import 'package:bluelinegpt_mobile/core/storage/driver_offline_database.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_repository.dart';
import 'package:bluelinegpt_mobile/core/services/driver_sync_controller.dart';
import 'package:bluelinegpt_mobile/features/customer/customer_repository.dart';
import 'package:bluelinegpt_mobile/features/communication/communication_repository.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:bluelinegpt_mobile/core/services/voice_io.dart';

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
  (ref) => ApiDeviceRegistrationService(ref.watch(apiClientProvider)),
);
final pushMessagingCoordinatorProvider = Provider<PushMessagingCoordinator>(
  (ref) => FirebasePushMessagingCoordinator(ref.watch(loggerProvider)),
);
final notificationInboxRepositoryProvider =
    Provider<NotificationInboxRepository>(
      (ref) => ApiNotificationInboxRepository(ref.watch(apiClientProvider)),
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

/// The plain online Driver repository — kept reusable and unwrapped so
/// `DriverSyncController` can also hold a direct reference to it (Prompt 16).
final driverApiRepositoryProvider = Provider<DriverRepository>(
  (ref) => ApiDriverRepository(ref.watch(apiClientProvider)),
);
final driverOfflineDatabaseProvider = Provider<DriverOfflineDatabase>(
  (ref) => DriverOfflineDatabase(),
);
final driverOfflineCacheRepositoryProvider =
    Provider<DriverOfflineCacheRepository>(
      (ref) => SqfliteDriverOfflineCacheRepository(
        ref.watch(driverOfflineDatabaseProvider),
      ),
    );
final driverSyncQueueRepositoryProvider = Provider<DriverSyncQueueRepository>(
  (ref) => SqfliteDriverSyncQueueRepository(
    ref.watch(driverOfflineDatabaseProvider),
  ),
);
final driverOfflineRepositoryProvider = Provider<OfflineAwareDriverRepository>(
  (ref) => OfflineAwareDriverRepository(
    api: ref.watch(driverApiRepositoryProvider),
    cache: ref.watch(driverOfflineCacheRepositoryProvider),
    queue: ref.watch(driverSyncQueueRepositoryProvider),
    currentUser: () => ref.read(authenticationProvider).value?.user,
    errorMapper: const ApiErrorMapper(),
  ),
);
final driverRepositoryProvider = Provider<DriverRepository>(
  (ref) => ref.watch(driverOfflineRepositoryProvider),
);
final operatorRepositoryProvider = Provider<OperatorRepository>(
  (ref) => ApiOperatorRepository(ref.watch(apiClientProvider)),
);
final customerRepositoryProvider = Provider<CustomerRepository>(
  (ref) => ApiCustomerRepository(ref.watch(apiClientProvider)),
);
final communicationRepositoryProvider = Provider<CommunicationRepository>(
  (ref) => ApiCommunicationRepository(ref.watch(apiClientProvider)),
);
// A dedicated `CommunicationRealtimeConnection` is opened per-conversation
// directly by `ConversationPage` (see core/services/communication_realtime.dart)
// rather than through this generic port — the gateway is scoped to one
// conversation per socket and delivers parsed message/conversation events,
// which `RealtimeClient` (connection-status-oriented, one socket for the
// whole session) was never designed to carry. `realtimeClientProvider`
// remains unrelated Prompt 15 scope.
final voiceRecorderProvider = Provider<VoiceRecorder>(
  (ref) => RecordPackageVoiceRecorder(),
);
// A single app-scoped player (not per-conversation) so "only one voice
// message plays at a time" holds even across a conversation switch, not just
// within one open conversation screen.
final voicePlayerProvider = Provider<VoicePlayer>(
  (ref) => AudioPlayersVoicePlayer(),
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
    driverOfflineStore: ref.watch(driverOfflineDatabaseProvider),
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
    // Stopped *before* the service call clears the offline cache/queue
    // (Prompt 16 §T) — a sync pass must never fire mid-clear, or against an
    // identity that is about to change. `DriverSyncController` also pauses
    // itself reactively once `state` below flips to unauthenticated; this
    // call closes the gap during the awaited service call itself, where the
    // reactive listener has not fired yet.
    ref.read(driverSyncControllerProvider).pause();
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
  // Firebase must be initialized before `authenticationProvider.future`
  // resolves — `restore()` (triggered by reading it below) calls
  // `notifications.token()` as part of `_connectOptionalServices`, and
  // `FirebaseMessaging.instance.getToken()` always returns null before
  // `Firebase.initializeApp()` has run once. Initializing first here means
  // a cold-start restore can register a device token on its very first
  // attempt instead of silently skipping it until the next login/restore.
  await ref.read(notificationServiceProvider).initialize();
  await ref.read(authenticationProvider.future);
  await ref.read(localeProvider.future);
});

final offlineProvider = StreamProvider<bool>((ref) async* {
  final connectivity = Connectivity();
  final initial = await connectivity.checkConnectivity();
  yield initial.contains(ConnectivityResult.none);
  yield* connectivity.onConnectivityChanged.map(
    (results) => results.contains(ConnectivityResult.none),
  );
});
