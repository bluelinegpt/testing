import 'package:bluelinegpt_mobile/app/configuration/app_environment.dart';
import 'package:flutter_test/flutter_test.dart';

AppConfiguration production({
  String api = 'https://api.bluelinegpt.example/api/v1',
  String realtime = 'wss://realtime.bluelinegpt.example',
  bool verbose = false,
  bool mocks = false,
}) => AppConfiguration(
  environment: AppEnvironment.production,
  apiBaseUrl: Uri.parse(api),
  realtimeUrl: Uri.parse(realtime),
  verboseLogging: verbose,
  enableMockServices: mocks,
);

void main() {
  test('secure production configuration is accepted', () {
    expect(production().validateForStartup, returnsNormally);
  });

  test('production rejects insecure and loopback endpoints', () {
    expect(
      production(api: 'http://127.0.0.1:3000').validateForStartup,
      throwsStateError,
    );
    expect(
      production(realtime: 'ws://localhost:3000').validateForStartup,
      throwsStateError,
    );
  });

  test('production rejects verbose logging and mock services', () {
    expect(production(verbose: true).validateForStartup, throwsStateError);
    expect(production(mocks: true).validateForStartup, throwsStateError);
  });

  test('development may use local endpoints and diagnostics', () {
    final configuration = AppConfiguration(
      environment: AppEnvironment.development,
      apiBaseUrl: Uri.parse('http://127.0.0.1:3000/api/v1'),
      realtimeUrl: Uri.parse('ws://127.0.0.1:3000/realtime'),
      verboseLogging: true,
      enableMockServices: true,
    );
    expect(configuration.validateForStartup, returnsNormally);
  });
}
