import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// One live subscription to a single conversation's realtime event stream —
/// ported from the Office Web implementation
/// (`apps/web/src/features/communication/communication-realtime.ts`). The
/// backend gateway is scoped to one conversation per socket, so a new
/// connection is opened whenever the active conversation changes and closed
/// when the user navigates away from it.
///
/// Handles automatic reconnect with exponential backoff (capped at 15s),
/// cursor-based replay on every (re)connect, sequence-number de-duplication,
/// and the durable-cursor-expired → full-refresh-required signal.

enum CommunicationRealtimeStatus { closed, connecting, open, reconnecting }

final class CommunicationRealtimeEvent {
  const CommunicationRealtimeEvent({
    required this.sequence,
    required this.type,
    required this.entityType,
    required this.entityId,
    required this.payload,
    required this.createdAt,
  });
  final String sequence, type, entityType, entityId, createdAt;
  final Object? payload;

  factory CommunicationRealtimeEvent.fromJson(Map<String, dynamic> json) =>
      CommunicationRealtimeEvent(
        sequence: json['sequence']?.toString() ?? '',
        type: json['type']?.toString() ?? '',
        entityType: json['entityType']?.toString() ?? '',
        entityId: json['entityId']?.toString() ?? '',
        payload: json['payload'],
        createdAt: json['createdAt']?.toString() ?? '',
      );
}

abstract interface class CommunicationRealtimeHandlers {
  void onEvent(CommunicationRealtimeEvent event);
  void onFullRefreshRequired();
  void onStatusChange(CommunicationRealtimeStatus status);
}

/// A minimal transport seam so the reconnect/dedup/cursor-expiry algorithm is
/// unit-testable without a real socket — the production implementation
/// (`IoRealtimeSocket`) wraps `dart:io`'s `WebSocket`.
abstract interface class RealtimeSocket {
  Stream<String> get messages;
  Future<void> close();
}

typedef RealtimeSocketConnector = Future<RealtimeSocket> Function(Uri uri);

final class IoRealtimeSocket implements RealtimeSocket {
  IoRealtimeSocket(this._socket);
  final WebSocket _socket;
  @override
  Stream<String> get messages =>
      _socket.map((event) => event is String ? event : '');
  @override
  Future<void> close() async {
    await _socket.close();
  }
}

Future<RealtimeSocket> connectIoRealtimeSocket(Uri uri) async =>
    IoRealtimeSocket(await WebSocket.connect(uri.toString()));

/// Builds the `/communication/realtime` WebSocket URL from the same
/// `apiBaseUrl` the REST client uses, mirroring
/// `communicationRealtimeUrl` on the Office Web client.
Uri communicationRealtimeUrl({
  required Uri apiBaseUrl,
  required String conversationId,
  required String accessToken,
}) {
  final scheme = apiBaseUrl.scheme == 'https' ? 'wss' : 'ws';
  final trimmedPath = apiBaseUrl.path.endsWith('/')
      ? apiBaseUrl.path.substring(0, apiBaseUrl.path.length - 1)
      : apiBaseUrl.path;
  return Uri(
    scheme: scheme,
    host: apiBaseUrl.host,
    port: apiBaseUrl.hasPort ? apiBaseUrl.port : null,
    path: '$trimmedPath/communication/realtime',
    queryParameters: {'token': accessToken, 'conversationId': conversationId},
  );
}

final class CommunicationRealtimeConnection {
  CommunicationRealtimeConnection({
    required this.url,
    required this.handlers,
    RealtimeSocketConnector? connector,
  }) : _connector = connector ?? connectIoRealtimeSocket;

  final Uri url;
  final CommunicationRealtimeHandlers handlers;
  final RealtimeSocketConnector _connector;

  RealtimeSocket? _socket;
  StreamSubscription<String>? _subscription;
  String? _cursor;
  final Set<String> _delivered = {};
  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  bool _closedByCaller = false;

  /// `initialCursor`, if supplied, resumes from a previously-seen sequence
  /// instead of replaying the full recent history again.
  void connect({String? initialCursor}) {
    _closedByCaller = false;
    if (initialCursor != null) _cursor = initialCursor;
    unawaited(_open());
  }

  Future<void> close() async {
    _closedByCaller = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    await _subscription?.cancel();
    _subscription = null;
    final socket = _socket;
    _socket = null;
    await socket?.close();
  }

  Future<void> _open() async {
    handlers.onStatusChange(
      _reconnectAttempt == 0
          ? CommunicationRealtimeStatus.connecting
          : CommunicationRealtimeStatus.reconnecting,
    );
    final cursor = _cursor;
    final target = cursor == null
        ? url
        : url.replace(
            queryParameters: {...url.queryParameters, 'cursor': cursor},
          );
    RealtimeSocket socket;
    try {
      socket = await _connector(target);
    } on Object {
      _scheduleReconnect();
      return;
    }
    if (_closedByCaller) {
      await socket.close();
      return;
    }
    _socket = socket;
    _reconnectAttempt = 0;
    handlers.onStatusChange(CommunicationRealtimeStatus.open);
    _subscription = socket.messages.listen(
      _handleMessage,
      onDone: () {
        if (!identical(_socket, socket)) return;
        _socket = null;
        if (_closedByCaller) {
          handlers.onStatusChange(CommunicationRealtimeStatus.closed);
          return;
        }
        _scheduleReconnect();
      },
      onError: (Object _) => socket.close(),
    );
  }

  void _handleMessage(String raw) {
    Object? parsed;
    try {
      parsed = jsonDecode(raw);
    } on Object {
      return;
    }
    if (parsed is! Map) return;
    final type = parsed['type'];
    if (type == 'cursor_expired' || parsed['fullRefreshRequired'] == true) {
      handlers.onFullRefreshRequired();
      return;
    }
    if (type == 'recovery' && parsed['events'] is List) {
      for (final event in parsed['events'] as List) {
        if (event is Map) {
          _dispatch(
            CommunicationRealtimeEvent.fromJson(
              Map<String, dynamic>.from(event),
            ),
          );
        }
      }
      return;
    }
    if (type == 'event' && parsed['event'] is Map) {
      _dispatch(
        CommunicationRealtimeEvent.fromJson(
          Map<String, dynamic>.from(parsed['event'] as Map),
        ),
      );
    }
  }

  void _dispatch(CommunicationRealtimeEvent event) {
    if (_delivered.contains(event.sequence)) return;
    _delivered.add(event.sequence);
    _cursor = event.sequence;
    handlers.onEvent(event);
  }

  void _scheduleReconnect() {
    handlers.onStatusChange(CommunicationRealtimeStatus.reconnecting);
    final delayMs = (1000 * (1 << _reconnectAttempt.clamp(0, 10))).clamp(
      0,
      15000,
    );
    _reconnectAttempt += 1;
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      if (!_closedByCaller) unawaited(_open());
    });
  }
}
