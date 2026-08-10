import 'package:bluelinegpt_mobile/features/communication/communication_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ConversationSummary.fromJson', () {
    test('parses a well-formed response including voice preview marker', () {
      final summary = ConversationSummary.fromJson({
        'id': 'conv-1',
        'type': 'order',
        'participantContextType': 'trader',
        'participantName': 'Trader A',
        'orderId': 'order-1',
        'orderNumber': 'ORD-1',
        'subject': null,
        'status': 'active',
        'priority': 'normal',
        'lastMessageAt': '2026-01-01T10:00:00.000Z',
        'lastMessagePreview': 'voice_message',
        'unreadCount': 3,
        'assignedOperatorAccountId': null,
        'assignedOperatorName': null,
      });
      expect(summary.id, 'conv-1');
      expect(summary.party, ConversationParty.trader);
      expect(summary.unreadCount, 3);
      expect(summary.lastMessageWasVoice, isTrue);
      expect(summary.displayTitle(), 'Trader A');
    });

    test('falls back through participant name, order number, subject, id', () {
      final withOrderOnly = ConversationSummary.fromJson({
        'id': 'conv-2',
        'status': 'active',
        'unreadCount': 0,
        'orderNumber': 'ORD-9',
      });
      expect(withOrderOnly.displayTitle(), 'ORD-9');

      final idOnly = ConversationSummary.fromJson({
        'id': 'conv-3',
        'status': 'active',
        'unreadCount': 0,
      });
      expect(idOnly.displayTitle(), 'conv-3');
    });

    test('fails loud on a missing id', () {
      expect(
        () => ConversationSummary.fromJson({
          'status': 'active',
          'unreadCount': 0,
        }),
        throwsA(isA<CommunicationParseError>()),
      );
    });
  });

  group('ConversationMessage.fromJson', () {
    test('parses a text message', () {
      final message = ConversationMessage.fromJson({
        'id': 'msg-1',
        'conversationId': 'conv-1',
        'senderRole': 'office',
        'messageType': 'text',
        'text': 'Hello',
        'clientMessageId': 'client-1',
        'systemEventType': null,
        'sequence': 1,
        'createdAt': '2026-01-01T10:00:00.000Z',
      });
      expect(message.type, CommunicationMessageType.text);
      expect(message.sender, ConversationParty.office);
      expect(message.isVoice, isFalse);
    });

    test('parses a voice message including media fields', () {
      final message = ConversationMessage.fromJson({
        'id': 'msg-2',
        'conversationId': 'conv-1',
        'senderRole': 'trader',
        'messageType': 'voice',
        'text': null,
        'clientMessageId': 'client-2',
        'systemEventType': null,
        'sequence': 2,
        'createdAt': '2026-01-01T10:05:00.000Z',
        'mediaMimeType': 'audio/m4a',
        'mediaDurationSeconds': 12,
        'mediaSizeBytes': 4096,
      });
      expect(message.isVoice, isTrue);
      expect(message.mediaMimeType, 'audio/m4a');
      expect(message.mediaDurationSeconds, 12);
      expect(message.mediaSizeBytes, 4096);
    });

    test('fails loud on a missing required field', () {
      expect(
        () => ConversationMessage.fromJson({
          'id': 'msg-3',
          'senderRole': 'office',
          'messageType': 'text',
          'sequence': 1,
          'createdAt': '2026-01-01T10:00:00.000Z',
        }),
        throwsA(isA<CommunicationParseError>()),
      );
    });

    test('fails loud on an unparseable createdAt', () {
      expect(
        () => ConversationMessage.fromJson({
          'id': 'msg-4',
          'conversationId': 'conv-1',
          'senderRole': 'office',
          'messageType': 'text',
          'sequence': 1,
          'createdAt': 'not-a-date',
        }),
        throwsA(isA<CommunicationParseError>()),
      );
    });
  });

  group(
    'OutgoingVoiceMessage.validationError (client-side UX mirror only)',
    () {
      OutgoingVoiceMessage recording({
        int sizeBytes = 1024,
        int durationSeconds = 5,
        String mimeType = 'audio/m4a',
      }) => OutgoingVoiceMessage(
        conversationId: 'conv-1',
        clientMessageId: 'client-1',
        idempotencyKey: 'key-12345678',
        originalClientTime: DateTime.utc(2026),
        filePath: '/tmp/voice.m4a',
        durationSeconds: durationSeconds,
        mimeType: mimeType,
        sizeBytes: sizeBytes,
      );

      test('a well-formed recording is valid', () {
        expect(recording().validationError(), isNull);
      });
      test('zero bytes is rejected as empty', () {
        expect(
          recording(sizeBytes: 0).validationError(),
          'voice_message_empty',
        );
      });
      test('oversized recordings are rejected', () {
        expect(
          recording(
            sizeBytes: VoiceMessageLimits.maxSizeBytes + 1,
          ).validationError(),
          'voice_message_too_large',
        );
      });
      test('durations outside 1-300s are rejected', () {
        expect(
          recording(durationSeconds: 0).validationError(),
          'voice_message_duration_invalid',
        );
        expect(
          recording(durationSeconds: 301).validationError(),
          'voice_message_duration_invalid',
        );
      });
      test('an unsupported MIME type is rejected', () {
        expect(
          recording(mimeType: 'audio/wav').validationError(),
          'voice_message_unsupported_type',
        );
      });
    },
  );
}
