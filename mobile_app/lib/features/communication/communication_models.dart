enum ConversationParty { office, trader, driver, customer }

enum CommunicationMessageType { text, voice, voicePlaceholder, system }

CommunicationMessageType communicationMessageTypeFrom(String value) =>
    switch (value) {
      'voice' => CommunicationMessageType.voice,
      'voice_placeholder' => CommunicationMessageType.voicePlaceholder,
      'system' => CommunicationMessageType.system,
      _ => CommunicationMessageType.text,
    };

ConversationParty _partyFromSenderRole(String value) => switch (value) {
  'office' => ConversationParty.office,
  'trader' => ConversationParty.trader,
  'driver' => ConversationParty.driver,
  'customer' => ConversationParty.customer,
  _ => ConversationParty.office,
};

ConversationParty _partyFromParticipantContextType(String value) =>
    switch (value) {
      'trader' => ConversationParty.trader,
      'driver' => ConversationParty.driver,
      'customer' => ConversationParty.customer,
      _ => ConversationParty.office,
    };

enum MessageDeliveryState { pending, sent, delivered, read, failed }

bool isAllowedConversation(ConversationParty first, ConversationParty second) {
  if (first == second) return false;
  return first == ConversationParty.office ||
      second == ConversationParty.office;
}

/// Server-enforced limits, mirrored client-side for responsive UX only — the
/// backend independently re-validates every one of these on the actual
/// upload (`voice_message_too_large`, `voice_message_duration_invalid`,
/// `voice_message_unsupported_type`, `voice_message_empty`).
abstract final class VoiceMessageLimits {
  static const maxDurationSeconds = 300;
  static const maxSizeBytes = 10 * 1024 * 1024;
  static const allowedMimeTypes = {
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/aac',
  };
}

final class OutgoingTextMessage {
  const OutgoingTextMessage({
    required this.conversationId,
    required this.clientMessageId,
    required this.idempotencyKey,
    required this.originalClientTime,
    required this.body,
  });
  final String conversationId, clientMessageId, idempotencyKey, body;
  final DateTime originalClientTime;
  String? validationError({int? backendMaximumLength}) {
    final trimmed = body.trim();
    if (trimmed.isEmpty) return 'empty';
    if (backendMaximumLength == null) return 'contract_unavailable';
    if (trimmed.length > backendMaximumLength) return 'too_long';
    return null;
  }
}

/// A recorded voice message ready to upload. `filePath` is the local file
/// written by the recorder (AAC/M4A) — sent as multipart `file`.
/// `clientMessageId`/`idempotencyKey` must be REUSED unchanged across retries
/// of the same recording; a resend after a network failure must never create
/// a duplicate message.
final class OutgoingVoiceMessage {
  const OutgoingVoiceMessage({
    required this.conversationId,
    required this.clientMessageId,
    required this.idempotencyKey,
    required this.originalClientTime,
    required this.filePath,
    required this.durationSeconds,
    required this.mimeType,
    required this.sizeBytes,
  });
  final String conversationId, clientMessageId, idempotencyKey, filePath;
  final String mimeType;
  final int durationSeconds, sizeBytes;
  final DateTime originalClientTime;

  /// Mirrors server-side rejection reasons purely for responsive UX; the
  /// backend remains authoritative (`voice_message_*` error codes).
  String? validationError() {
    if (sizeBytes <= 0) return 'voice_message_empty';
    if (sizeBytes > VoiceMessageLimits.maxSizeBytes) {
      return 'voice_message_too_large';
    }
    if (durationSeconds < 1 ||
        durationSeconds > VoiceMessageLimits.maxDurationSeconds) {
      return 'voice_message_duration_invalid';
    }
    if (!VoiceMessageLimits.allowedMimeTypes.contains(mimeType)) {
      return 'voice_message_unsupported_type';
    }
    return null;
  }
}

final class MessageDeduplicator {
  final Set<String> _serverIds = {}, _clientIds = {};
  bool accept({required String serverId, required String clientMessageId}) =>
      _serverIds.add(serverId) && _clientIds.add(clientMessageId);
}

final class ConversationListResult {
  const ConversationListResult({required this.items, this.nextCursor});
  final List<ConversationSummary> items;
  final String? nextCursor;
}

final class MessageListResult {
  const MessageListResult({required this.items, this.nextCursor});
  final List<ConversationMessage> items;
  final String? nextCursor;
}

final class UnreadSummary {
  const UnreadSummary({
    required this.unreadMessages,
    required this.unreadConversations,
  });
  final int unreadMessages, unreadConversations;
}

/// `lastMessagePreview` may carry the literal server marker `"voice_message"`
/// instead of raw text when the last message in the conversation was a
/// voice note — callers must localize that marker rather than display it.
const String voiceMessagePreviewMarker = 'voice_message';

final class ConversationSummary {
  const ConversationSummary({
    required this.id,
    required this.party,
    required this.status,
    required this.unreadCount,
    this.orderId,
    this.orderNumber,
    this.subject,
    this.participantName,
    this.priority,
    this.lastMessageAt,
    this.lastMessagePreview,
    this.assignedOperatorAccountId,
    this.assignedOperatorName,
  });

  final String id, status;
  final ConversationParty party;
  final String? orderId,
      orderNumber,
      subject,
      participantName,
      priority,
      lastMessagePreview,
      assignedOperatorAccountId,
      assignedOperatorName;
  final DateTime? lastMessageAt;
  final int unreadCount;

  /// The best available display title for an inbox row: the participant's
  /// name when known, falling back to the Order number, then the subject,
  /// never a raw internal id.
  String displayTitle() => participantName?.trim().isNotEmpty == true
      ? participantName!
      : orderNumber?.trim().isNotEmpty == true
      ? orderNumber!
      : subject?.trim().isNotEmpty == true
      ? subject!
      : id;

  bool get lastMessageWasVoice =>
      lastMessagePreview == voiceMessagePreviewMarker;

  factory ConversationSummary.fromJson(Map<String, dynamic> value) {
    final id = value['id'];
    final status = value['status'];
    if (id is! String || id.isEmpty) {
      throw const CommunicationParseError('missing_field_id');
    }
    if (status is! String || status.isEmpty) {
      throw const CommunicationParseError('missing_field_status');
    }
    final unread = value['unreadCount'];
    final contextType = value['participantContextType'];
    return ConversationSummary(
      id: id,
      party: contextType is String
          ? _partyFromParticipantContextType(contextType)
          : ConversationParty.office,
      status: status,
      unreadCount: unread is int ? unread : 0,
      orderId: value['orderId'] as String?,
      orderNumber: value['orderNumber'] as String?,
      subject: value['subject'] as String?,
      participantName: value['participantName'] as String?,
      priority: value['priority'] as String?,
      lastMessageAt: DateTime.tryParse(
        value['lastMessageAt']?.toString() ?? '',
      )?.toLocal(),
      lastMessagePreview: value['lastMessagePreview'] as String?,
      assignedOperatorAccountId: value['assignedOperatorAccountId'] as String?,
      assignedOperatorName: value['assignedOperatorName'] as String?,
    );
  }
}

final class ConversationMessage {
  const ConversationMessage({
    required this.id,
    required this.conversationId,
    required this.type,
    required this.sender,
    required this.sequence,
    required this.createdAt,
    this.text,
    this.clientMessageId,
    this.systemEventType,
    this.mediaMimeType,
    this.mediaDurationSeconds,
    this.mediaSizeBytes,
  });

  final String id, conversationId;
  final CommunicationMessageType type;
  final ConversationParty sender;
  final int sequence;
  final DateTime createdAt;
  final String? text, clientMessageId, systemEventType, mediaMimeType;
  final int? mediaDurationSeconds, mediaSizeBytes;

  bool get isVoice => type == CommunicationMessageType.voice;

  factory ConversationMessage.fromJson(Map<String, dynamic> value) {
    final id = value['id'];
    final conversationId = value['conversationId'];
    final senderRole = value['senderRole'];
    final messageType = value['messageType'];
    final sequence = value['sequence'];
    final createdAt = value['createdAt'];
    if (id is! String || id.isEmpty) {
      throw const CommunicationParseError('missing_field_id');
    }
    if (conversationId is! String || conversationId.isEmpty) {
      throw const CommunicationParseError('missing_field_conversationId');
    }
    if (senderRole is! String) {
      throw const CommunicationParseError('missing_field_senderRole');
    }
    if (messageType is! String) {
      throw const CommunicationParseError('missing_field_messageType');
    }
    if (sequence is! int) {
      throw const CommunicationParseError('invalid_field_sequence');
    }
    final createdAtParsed = DateTime.tryParse(createdAt?.toString() ?? '');
    if (createdAtParsed == null) {
      throw const CommunicationParseError('invalid_field_createdAt');
    }
    return ConversationMessage(
      id: id,
      conversationId: conversationId,
      type: communicationMessageTypeFrom(messageType),
      sender: _partyFromSenderRole(senderRole),
      sequence: sequence,
      createdAt: createdAtParsed.toLocal(),
      text: value['text'] as String?,
      clientMessageId: value['clientMessageId'] as String?,
      systemEventType: value['systemEventType'] as String?,
      mediaMimeType: value['mediaMimeType'] as String?,
      mediaDurationSeconds: value['mediaDurationSeconds'] is int
          ? value['mediaDurationSeconds'] as int
          : null,
      mediaSizeBytes: value['mediaSizeBytes'] is int
          ? value['mediaSizeBytes'] as int
          : null,
    );
  }
}

final class CommunicationParseError implements Exception {
  const CommunicationParseError(this.code);
  final String code;
}
