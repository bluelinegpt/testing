enum ConversationParty { office, trader, driver, customer }

enum CommunicationMessageType { text, voice, system }

enum MessageDeliveryState { pending, sent, delivered, read, failed }

bool isAllowedConversation(ConversationParty first, ConversationParty second) {
  if (first == second) return false;
  return first == ConversationParty.office ||
      second == ConversationParty.office;
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

final class MessageDeduplicator {
  final Set<String> _serverIds = {}, _clientIds = {};
  bool accept({required String serverId, required String clientMessageId}) =>
      _serverIds.add(serverId) && _clientIds.add(clientMessageId);
}

abstract interface class CommunicationRepository {
  Future<List<ConversationSummary>> conversations();
  Future<List<ConversationMessage>> messages(String conversationId);
  Future<ConversationMessage> sendText(OutgoingTextMessage message);
  Future<int> markVisibleRead(String conversationId, String throughMessageId);
}

final class UnsupportedCommunicationRepository
    implements CommunicationRepository {
  const UnsupportedCommunicationRepository();
  Future<Never> _unavailable() => Future.error(
    UnsupportedError('Shared communication backend is unavailable'),
  );
  @override
  Future<Never> conversations() => _unavailable();
  @override
  Future<Never> messages(String conversationId) => _unavailable();
  @override
  Future<Never> sendText(OutgoingTextMessage message) => _unavailable();
  @override
  Future<Never> markVisibleRead(
    String conversationId,
    String throughMessageId,
  ) => _unavailable();
}

final class ConversationSummary {
  const ConversationSummary({
    required this.id,
    required this.party,
    required this.status,
    required this.unreadCount,
    this.orderNumber,
    this.lastMessagePreview,
  });

  final String id, status;
  final ConversationParty party;
  final String? orderNumber, lastMessagePreview;
  final int unreadCount;
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
  });

  final String id, conversationId;
  final CommunicationMessageType type;
  final ConversationParty sender;
  final int sequence;
  final DateTime createdAt;
  final String? text, clientMessageId, systemEventType;
}
