import 'package:bluelinegpt_mobile/features/communication/communication_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('only Office-hub role pairings are allowed', () {
    expect(
      isAllowedConversation(ConversationParty.driver, ConversationParty.office),
      isTrue,
    );
    expect(
      isAllowedConversation(ConversationParty.trader, ConversationParty.office),
      isTrue,
    );
    expect(
      isAllowedConversation(
        ConversationParty.customer,
        ConversationParty.office,
      ),
      isTrue,
    );
    expect(
      isAllowedConversation(ConversationParty.driver, ConversationParty.trader),
      isFalse,
    );
    expect(
      isAllowedConversation(
        ConversationParty.customer,
        ConversationParty.driver,
      ),
      isFalse,
    );
    expect(
      isAllowedConversation(
        ConversationParty.customer,
        ConversationParty.trader,
      ),
      isFalse,
    );
  });
  test('text cannot be accepted before backend maximum is known', () {
    final message = OutgoingTextMessage(
      conversationId: 'c',
      clientMessageId: 'client',
      idempotencyKey: 'key',
      originalClientTime: DateTime.utc(2026),
      body: 'Hello',
    );
    expect(message.validationError(), 'contract_unavailable');
    expect(message.validationError(backendMaximumLength: 10), isNull);
  });
  test('empty and over-limit messages are rejected', () {
    final empty = OutgoingTextMessage(
      conversationId: 'c',
      clientMessageId: '1',
      idempotencyKey: 'k1',
      originalClientTime: DateTime.utc(2026),
      body: '  ',
    );
    final long = OutgoingTextMessage(
      conversationId: 'c',
      clientMessageId: '2',
      idempotencyKey: 'k2',
      originalClientTime: DateTime.utc(2026),
      body: '123456',
    );
    expect(empty.validationError(backendMaximumLength: 10), 'empty');
    expect(long.validationError(backendMaximumLength: 5), 'too_long');
  });
  test('server and client identifiers prevent duplicate events', () {
    final deduplicator = MessageDeduplicator();
    expect(deduplicator.accept(serverId: 's1', clientMessageId: 'c1'), isTrue);
    expect(deduplicator.accept(serverId: 's1', clientMessageId: 'c1'), isFalse);
    expect(deduplicator.accept(serverId: 's2', clientMessageId: 'c1'), isFalse);
  });
}
