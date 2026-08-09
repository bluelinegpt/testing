enum AppEnvironment { development, staging, production }

final class AppConfiguration {
  const AppConfiguration({
    required this.environment,
    required this.apiBaseUrl,
    required this.realtimeUrl,
    required this.verboseLogging,
    required this.enableMockServices,
  });

  factory AppConfiguration.fromDefines() {
    const name = String.fromEnvironment(
      'ENVIRONMENT_NAME',
      defaultValue: 'development',
    );
    final environment = switch (name) {
      'production' => AppEnvironment.production,
      'staging' => AppEnvironment.staging,
      _ => AppEnvironment.development,
    };
    const apiUrl = String.fromEnvironment(
      'API_BASE_URL',
      defaultValue: 'http://127.0.0.1:3000/api/v1',
    );
    const realtimeUrl = String.fromEnvironment(
      'REALTIME_URL',
      defaultValue: 'ws://127.0.0.1:3000/realtime',
    );
    final configuration = AppConfiguration(
      environment: environment,
      apiBaseUrl: Uri.parse(apiUrl),
      realtimeUrl: Uri.parse(realtimeUrl),
      verboseLogging: const bool.fromEnvironment(
        'ENABLE_VERBOSE_LOGGING',
        defaultValue: true,
      ),
      enableMockServices: const bool.fromEnvironment('ENABLE_MOCK_SERVICES'),
    );
    configuration.validateForStartup();
    return configuration;
  }

  final AppEnvironment environment;
  final Uri apiBaseUrl;
  final Uri realtimeUrl;
  final bool verboseLogging;
  final bool enableMockServices;

  void validateForStartup() {
    if (environment != AppEnvironment.production) return;
    final invalidApi =
        apiBaseUrl.scheme != 'https' ||
        apiBaseUrl.host.isEmpty ||
        _isLoopback(apiBaseUrl.host);
    final invalidRealtime =
        realtimeUrl.scheme != 'wss' ||
        realtimeUrl.host.isEmpty ||
        _isLoopback(realtimeUrl.host);
    if (invalidApi || invalidRealtime) {
      throw StateError('Production endpoints must use non-loopback HTTPS/WSS');
    }
    if (verboseLogging || enableMockServices) {
      throw StateError(
        'Verbose logging and mock services must be disabled in production',
      );
    }
  }

  bool _isLoopback(String host) =>
      host == 'localhost' || host == '127.0.0.1' || host == '::1';
}
