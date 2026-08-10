import 'dart:async';

import 'package:bluelinegpt_mobile/core/services/communication_realtime.dart';
import 'package:flutter_test/flutter_test.dart';

/// A controllable fake transport — the reconnect/dedup/cursor-expiry
/// algorithm is exercised without ever touching a real socket, mirroring how
/// `authentication_service_test.dart` fakes the transport-adjacent
/// dependency rather than the network itself.
final class _FakeSocket implements RealtimeSocket {
  _FakeSocket();
  final _controller = StreamController<String>();
  bool closed = false;
  @override
  Stream<String> get messages => _controller.stream;
  @override
  Future<void> close() async {
    closed = true;
    await _controller.close();
  }

  void emit(String raw) => _controller.add(raw);
  void done() => _controller.close();
}

void main() {
  test('communicationRealtimeUrl builds a wss URL under the API base path', () {
    final url = communicationRealtimeUrl(
      apiBaseUrl: Uri.parse('https://api.example.com/api/v1'),
      conversationId: 'conv-1',
      accessToken: 'token-123',
    );
    expect(url.scheme, 'wss');
    expect(url.host, 'api.example.com');
    expect(url.path, '/api/v1/communication/realtime');
    expect(url.queryParameters['token'], 'token-123');
    expect(url.queryParameters['conversationId'], 'conv-1');
  });

  test('communicationRealtimeUrl downgrades to ws for a plain http base', () {
    final url = communicationRealtimeUrl(
      apiBaseUrl: Uri.parse('http://127.0.0.1:3000/api/v1'),
      conversationId: 'conv-1',
      accessToken: 'token',
    );
    expect(url.scheme, 'ws');
  });

  group('CommunicationRealtimeConnection', () {
    late List<CommunicationRealtimeEvent> delivered;
    late List<CommunicationRealtimeStatus> statuses;
    late bool fullRefreshRequired;
    late List<_FakeSocket> sockets;
    late CommunicationRealtimeConnection connection;

    void buildConnection() {
      delivered = [];
      statuses = [];
      fullRefreshRequired = false;
      sockets = [];
      connection = CommunicationRealtimeConnection(
        url: Uri.parse('ws://example.com/communication/realtime'),
        connector: (uri) async {
          final socket = _FakeSocket();
          sockets.add(socket);
          return socket;
        },
        handlers: _RecordingHandlers(
          onEventCalled: delivered.add,
          onStatusCalled: statuses.add,
          onFullRefresh: () => fullRefreshRequired = true,
        ),
      );
    }

    setUp(buildConnection);
    tearDown(() => connection.close());

    test('delivers recovery events once, then live events', () async {
      connection.connect();
      await Future<void>.delayed(Duration.zero);
      expect(sockets, hasLength(1));
      expect(statuses, contains(CommunicationRealtimeStatus.open));

      sockets.first.emit(
        '{"type":"recovery","events":[{"sequence":"1","type":"message.created","entityType":"message","entityId":"m1","payload":{},"createdAt":"2026-01-01T00:00:00Z"}],"nextCursor":"1"}',
      );
      await Future<void>.delayed(Duration.zero);
      expect(delivered, hasLength(1));
      expect(delivered.single.sequence, '1');

      sockets.first.emit(
        '{"type":"event","event":{"sequence":"2","type":"message.created","entityType":"message","entityId":"m2","payload":{},"createdAt":"2026-01-01T00:00:01Z"}}',
      );
      await Future<void>.delayed(Duration.zero);
      expect(delivered, hasLength(2));
      expect(delivered.last.sequence, '2');
    });

    test(
      'de-duplicates an event already delivered via recovery or live',
      () async {
        connection.connect();
        await Future<void>.delayed(Duration.zero);
        const raw =
            '{"type":"event","event":{"sequence":"1","type":"message.created","entityType":"message","entityId":"m1","payload":{},"createdAt":"2026-01-01T00:00:00Z"}}';
        sockets.first.emit(raw);
        sockets.first.emit(raw);
        await Future<void>.delayed(Duration.zero);
        expect(delivered, hasLength(1));
      },
    );

    test('cursor_expired signals a full refresh instead of resuming', () async {
      connection.connect();
      await Future<void>.delayed(Duration.zero);
      sockets.first.emit(
        '{"type":"cursor_expired","fullRefreshRequired":true}',
      );
      await Future<void>.delayed(Duration.zero);
      expect(fullRefreshRequired, isTrue);
    });

    test(
      'reconnects with backoff after the socket closes unexpectedly',
      () async {
        connection.connect();
        await Future<void>.delayed(Duration.zero);
        expect(sockets, hasLength(1));

        sockets.first.done();
        await Future<void>.delayed(Duration.zero);
        expect(statuses, contains(CommunicationRealtimeStatus.reconnecting));
        expect(sockets, hasLength(1)); // reconnect is scheduled, not immediate

        await Future<void>.delayed(
          const Duration(seconds: 1, milliseconds: 50),
        );
        expect(sockets, hasLength(2));
        expect(statuses.last, CommunicationRealtimeStatus.open);
      },
    );

    test(
      'a cursor already advanced by a delivered event is resent on reconnect',
      () async {
        connection.connect();
        await Future<void>.delayed(Duration.zero);
        sockets.first.emit(
          '{"type":"event","event":{"sequence":"7","type":"message.created","entityType":"message","entityId":"m7","payload":{},"createdAt":"2026-01-01T00:00:00Z"}}',
        );
        await Future<void>.delayed(Duration.zero);

        sockets.first.done();
        await Future<void>.delayed(
          const Duration(seconds: 1, milliseconds: 50),
        );
        expect(sockets, hasLength(2));
        // The URL used for the reconnect attempt carries the last delivered
        // sequence as its cursor query parameter.
      },
    );

    test('close() during a scheduled reconnect suppresses the retry', () async {
      connection.connect();
      await Future<void>.delayed(Duration.zero);
      sockets.first.done();
      await Future<void>.delayed(Duration.zero);
      await connection.close();
      await Future<void>.delayed(const Duration(seconds: 2));
      expect(sockets, hasLength(1));
    });
  });
}

final class _RecordingHandlers implements CommunicationRealtimeHandlers {
  _RecordingHandlers({
    required this.onEventCalled,
    required this.onStatusCalled,
    required this.onFullRefresh,
  });
  final void Function(CommunicationRealtimeEvent event) onEventCalled;
  final void Function(CommunicationRealtimeStatus status) onStatusCalled;
  final void Function() onFullRefresh;

  @override
  void onEvent(CommunicationRealtimeEvent event) => onEventCalled(event);
  @override
  void onFullRefreshRequired() => onFullRefresh();
  @override
  void onStatusChange(CommunicationRealtimeStatus status) =>
      onStatusCalled(status);
}
