import 'dart:typed_data';

import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/features/communication/communication_models.dart';
import 'package:dio/dio.dart' as dio;

abstract interface class CommunicationRepository {
  Future<ConversationListResult> conversations({
    String? cursor,
    int limit = 25,
    String? status,
    String? search,
    bool unreadOnly = false,
  });
  Future<MessageListResult> messages(
    String conversationId, {
    String? before,
    String? after,
    int limit = 25,
  });
  Future<ConversationMessage> sendText(OutgoingTextMessage message);
  Future<ConversationMessage> sendVoice(OutgoingVoiceMessage message);
  Future<int> markRead(String conversationId, String throughMessageId);
  Future<UnreadSummary> unreadCount();
  Future<Uint8List> mediaBytes(String messageId);
}

final class UnsupportedCommunicationRepository
    implements CommunicationRepository {
  const UnsupportedCommunicationRepository();
  Future<Never> _unavailable() => Future.error(
    UnsupportedError('Shared communication backend is unavailable'),
  );
  @override
  Future<Never> conversations({
    String? cursor,
    int limit = 25,
    String? status,
    String? search,
    bool unreadOnly = false,
  }) => _unavailable();
  @override
  Future<Never> messages(
    String conversationId, {
    String? before,
    String? after,
    int limit = 25,
  }) => _unavailable();
  @override
  Future<Never> sendText(OutgoingTextMessage message) => _unavailable();
  @override
  Future<Never> sendVoice(OutgoingVoiceMessage message) => _unavailable();
  @override
  Future<Never> markRead(String conversationId, String throughMessageId) =>
      _unavailable();
  @override
  Future<Never> unreadCount() => _unavailable();
  @override
  Future<Never> mediaBytes(String messageId) => _unavailable();
}

final class ApiCommunicationRepository implements CommunicationRepository {
  ApiCommunicationRepository(this.api);
  final ApiClient api;

  @override
  Future<ConversationListResult> conversations({
    String? cursor,
    int limit = 25,
    String? status,
    String? search,
    bool unreadOnly = false,
  }) async {
    final query = <String, dynamic>{'limit': limit};
    if (cursor != null) query['cursor'] = cursor;
    if (status != null) query['status'] = status;
    if (search?.trim().isNotEmpty == true) query['search'] = search!.trim();
    if (unreadOnly) query['unreadOnly'] = 'true';
    final response = await api.getWithQuery<Object?>(
      'communication/conversations',
      queryParameters: query,
    );
    final data = response.data;
    if (data is! Map || data['items'] is! List) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    try {
      return ConversationListResult(
        items: [
          for (final item in data['items'] as List)
            if (item is Map)
              ConversationSummary.fromJson(Map<String, dynamic>.from(item)),
        ],
        nextCursor: data['nextCursor'] as String?,
      );
    } on CommunicationParseError catch (error) {
      throw ApiFailure(ApiFailureKind.invalidResponse, code: error.code);
    }
  }

  @override
  Future<MessageListResult> messages(
    String conversationId, {
    String? before,
    String? after,
    int limit = 25,
  }) async {
    final query = <String, dynamic>{'limit': limit};
    if (before != null) query['before'] = before;
    if (after != null) query['after'] = after;
    final response = await api.getWithQuery<Object?>(
      'communication/conversations/$conversationId/messages',
      queryParameters: query,
    );
    final data = response.data;
    if (data is! Map || data['items'] is! List) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    try {
      return MessageListResult(
        items: [
          for (final item in data['items'] as List)
            if (item is Map)
              ConversationMessage.fromJson(Map<String, dynamic>.from(item)),
        ],
        nextCursor: data['nextCursor'] as String?,
      );
    } on CommunicationParseError catch (error) {
      throw ApiFailure(ApiFailureKind.invalidResponse, code: error.code);
    }
  }

  @override
  Future<ConversationMessage> sendText(OutgoingTextMessage message) async {
    final data = (await api.post<Object?>(
      'communication/conversations/${message.conversationId}/messages',
      data: {
        'text': message.body,
        'clientMessageId': message.clientMessageId,
        'idempotencyKey': message.idempotencyKey,
        'originalClientTime': message.originalClientTime
            .toUtc()
            .toIso8601String(),
      },
    )).data;
    return _parseMessage(data);
  }

  @override
  Future<ConversationMessage> sendVoice(OutgoingVoiceMessage message) async {
    final form = dio.FormData.fromMap({
      'file': await dio.MultipartFile.fromFile(
        message.filePath,
        filename: 'voice-message.${_extensionFor(message.mimeType)}',
        contentType: dio.DioMediaType.parse(message.mimeType),
      ),
      'clientMessageId': message.clientMessageId,
      'idempotencyKey': message.idempotencyKey,
      'durationSeconds': message.durationSeconds.toString(),
      'originalClientTime': message.originalClientTime
          .toUtc()
          .toIso8601String(),
    });
    final data = (await api.post<Object?>(
      'communication/conversations/${message.conversationId}/voice-messages',
      data: form,
    )).data;
    return _parseMessage(data);
  }

  @override
  Future<int> markRead(String conversationId, String throughMessageId) async {
    final data = (await api.post<Object?>(
      'communication/conversations/$conversationId/read',
      data: {'throughMessageId': throughMessageId},
    )).data;
    if (data is! Map || data['unreadCount'] is! int) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return data['unreadCount'] as int;
  }

  @override
  Future<UnreadSummary> unreadCount() async {
    final data = (await api.get<Object?>(
      'communication/messages/unread-count',
    )).data;
    if (data is! Map ||
        data['unreadMessages'] is! int ||
        data['unreadConversations'] is! int) {
      throw const ApiFailure(ApiFailureKind.invalidResponse);
    }
    return UnreadSummary(
      unreadMessages: data['unreadMessages'] as int,
      unreadConversations: data['unreadConversations'] as int,
    );
  }

  @override
  Future<Uint8List> mediaBytes(String messageId) =>
      api.getBytes('communication/messages/$messageId/media');

  ConversationMessage _parseMessage(Object? data) {
    if (data is! Map) throw const ApiFailure(ApiFailureKind.invalidResponse);
    try {
      return ConversationMessage.fromJson(Map<String, dynamic>.from(data));
    } on CommunicationParseError catch (error) {
      throw ApiFailure(ApiFailureKind.invalidResponse, code: error.code);
    }
  }

  static String _extensionFor(String mimeType) => switch (mimeType) {
    'audio/aac' => 'aac',
    _ => 'm4a',
  };
}
