import 'package:bluelinegpt_mobile/app/configuration/app_environment.dart';
import 'package:dio/dio.dart';

/// Reports an uncaught crash to the same Error Handler screen every other
/// BluelineGPT app (web, api, platform-web, store) reports to.
///
/// Called from `bootstrap.dart`'s top-level error handlers, which run
/// BEFORE `runApp` -- before Riverpod's provider tree, and therefore before
/// the app's real [ApiClient] exists to be injected. [AppConfiguration
/// .fromDefines] is a plain synchronous factory reading compile-time
/// `--dart-define` values, so it is available immediately with no
/// initialization order to get wrong, and a bare, one-off [Dio] instance is
/// used here rather than the shared client's interceptor stack (auth
/// headers, correlation IDs) which none of this needs.
///
/// Always the PUBLIC endpoint (`/errors/public`): the same reasoning as the
/// Store's `error-reporting-client.ts` -- a Driver, Trader, or Operator may
/// crash before ever signing in, or an expired session may mean there is no
/// valid token to attach. See `ClientErrorReportController`'s own comment
/// for the full reasoning.
///
/// Deliberately never throws or awaits its own failure back to the caller:
/// reporting a crash must never cause a second crash, and the caller
/// (already inside a top-level error handler) has nothing useful to do with
/// a reporting failure anyway.
Future<void> reportCrash(Object error, StackTrace stack, {String? path}) async {
  try {
    final configuration = AppConfiguration.fromDefines();
    final dio = Dio(
      BaseOptions(
        connectTimeout: const Duration(seconds: 5),
        sendTimeout: const Duration(seconds: 5),
        headers: const {'Accept': 'application/json'},
      ),
    );
    // Truncated to match ReportClientErrorDto's own @MaxLength -- a message
    // or stack over the API's limit would 400 and be silently swallowed by
    // the catch below, reporting nothing instead of a truncated but useful
    // report.
    await dio.post<void>(
      ApiClientEndpoint.resolve(configuration.apiBaseUrl, 'errors/public'),
      data: {
        'sourceApp': 'mobile',
        'message': _truncate(error.toString(), 2000),
        'stack': _truncate(stack.toString(), 8000),
        'appCommit': configuration.appCommit,
        'path': ?path,
      },
    );
  } catch (_) {
    // See doc comment above -- a broken report must never mask the crash it
    // was trying to describe.
  }
}

String _truncate(String value, int maxLength) =>
    value.length <= maxLength ? value : value.substring(0, maxLength);

/// Resolves a relative API endpoint the same way [ApiClient.endpointUrl]
/// does, without depending on that class (which is constructed too late for
/// this file's purpose -- see the doc comment above).
abstract final class ApiClientEndpoint {
  static String resolve(Uri baseUrl, String endpoint) {
    final directory = baseUrl.toString().endsWith('/')
        ? baseUrl.toString()
        : '${baseUrl.toString()}/';
    return Uri.parse(directory).resolve(endpoint).toString();
  }
}
