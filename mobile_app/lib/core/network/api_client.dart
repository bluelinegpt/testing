import 'dart:math';
import 'dart:typed_data';

import 'package:dio/dio.dart';

enum ApiFailureKind {
  validation,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  rateLimited,
  server,
  unavailable,
  timeout,
  cancelled,
  invalidResponse,
  network,
}

final class ApiFailure implements Exception {
  const ApiFailure(this.kind, {this.code, this.correlationId, this.statusCode});
  final ApiFailureKind kind;
  final String? code;
  final String? correlationId;
  final int? statusCode;
}

final class ApiErrorMapper {
  const ApiErrorMapper();

  ApiFailure map(Object error) {
    if (error is! DioException) {
      return const ApiFailure(ApiFailureKind.invalidResponse);
    }
    if (error.type == DioExceptionType.cancel) {
      return const ApiFailure(ApiFailureKind.cancelled);
    }
    if (error.type == DioExceptionType.connectionTimeout ||
        error.type == DioExceptionType.receiveTimeout ||
        error.type == DioExceptionType.sendTimeout) {
      return const ApiFailure(ApiFailureKind.timeout);
    }
    final status = error.response?.statusCode;
    final body = error.response?.data;
    final envelope = body is Map<String, dynamic> && body['error'] is Map
        ? Map<String, dynamic>.from(body['error'] as Map)
        : const <String, dynamic>{};
    final details = (
      code: envelope['code'] as String?,
      correlation: envelope['correlationId'] as String?,
    );
    final kind = switch (status) {
      400 || 422 => ApiFailureKind.validation,
      401 => ApiFailureKind.unauthorized,
      403 => ApiFailureKind.forbidden,
      404 => ApiFailureKind.notFound,
      409 => ApiFailureKind.conflict,
      429 => ApiFailureKind.rateLimited,
      500 => ApiFailureKind.server,
      503 => ApiFailureKind.unavailable,
      null => ApiFailureKind.network,
      _ => ApiFailureKind.invalidResponse,
    };
    return ApiFailure(
      kind,
      code: details.code,
      correlationId: details.correlation,
      statusCode: status,
    );
  }
}

final class ApiClient {
  ApiClient({required Uri baseUrl, required this.tokenProvider})
    : _dio = Dio(
        BaseOptions(
          // Dio resolves relative request paths against this URI. A missing
          // trailing slash makes `/api/v1` behave like a file and turns
          // `auth/login` into `/api/auth/login`, which is not an API route.
          baseUrl: _directoryBaseUrl(baseUrl),
          connectTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(seconds: 30),
          sendTimeout: const Duration(seconds: 30),
          headers: const {'Accept': 'application/json'},
        ),
      ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          final token = await tokenProvider();
          if (token != null) options.headers['Authorization'] = 'Bearer $token';
          options.headers['X-Correlation-ID'] = _correlationId();
          handler.next(options);
        },
      ),
    );
  }

  final Dio _dio;
  final Future<String?> Function() tokenProvider;

  static String _directoryBaseUrl(Uri baseUrl) {
    final value = baseUrl.toString();
    return value.endsWith('/') ? value : '$value/';
  }

  Future<Response<T>> get<T>(String path, {CancelToken? cancelToken}) =>
      _dio.get<T>(path, cancelToken: cancelToken);

  Future<Response<T>> getWithQuery<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
    CancelToken? cancelToken,
  }) => _dio.get<T>(
    path,
    queryParameters: queryParameters,
    cancelToken: cancelToken,
  );

  Future<Response<T>> post<T>(
    String path, {
    Object? data,
    CancelToken? cancelToken,
  }) => _dio.post<T>(path, data: data, cancelToken: cancelToken);

  Future<Response<T>> postWithHeaders<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? headers,
    CancelToken? cancelToken,
  }) => _dio.post<T>(
    path,
    data: data,
    options: Options(headers: headers),
    cancelToken: cancelToken,
  );

  Future<Response<T>> patch<T>(
    String path, {
    Object? data,
    CancelToken? cancelToken,
  }) => _dio.patch<T>(path, data: data, cancelToken: cancelToken);

  Future<Response<T>> patchWithHeaders<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? headers,
    CancelToken? cancelToken,
  }) => _dio.patch<T>(
    path,
    data: data,
    options: Options(headers: headers),
    cancelToken: cancelToken,
  );

  /// Fetches a binary response body (e.g. authenticated media downloads) —
  /// `get<T>` alone cannot request `ResponseType.bytes`, and this must always
  /// go through the shared client so the auth-header interceptor still runs.
  Future<Uint8List> getBytes(String path, {CancelToken? cancelToken}) async {
    final response = await _dio.get<List<int>>(
      path,
      options: Options(responseType: ResponseType.bytes),
      cancelToken: cancelToken,
    );
    final data = response.data;
    if (data == null) throw const ApiFailure(ApiFailureKind.invalidResponse);
    return Uint8List.fromList(data);
  }

  static String _correlationId() {
    final random = Random.secure();
    return List.generate(
      16,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }
}
