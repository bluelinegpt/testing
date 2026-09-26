import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/app/theme/app_theme.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/services/communication_realtime.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/core/services/voice_io.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';
import 'package:bluelinegpt_mobile/features/communication/communication_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart' as intl;
import 'package:uuid/uuid.dart';

/// The backend's `SendTextMessageDto.text` bound (`@MaxLength(4000)`).
const int communicationTextMaxLength = 4000;

ConversationParty? _partyForUser(AuthenticatedUser? user) {
  if (user == null) return null;
  if (user.hasRole(UserRole.trader)) return ConversationParty.trader;
  if (user.hasRole(UserRole.driver)) return ConversationParty.driver;
  if (user.hasRole(UserRole.customer)) return ConversationParty.customer;
  return null;
}

bool _canRecordVoice(AuthenticatedUser? user) =>
    user != null &&
    (user.hasRole(UserRole.trader) || user.hasRole(UserRole.driver));

final class CommunicationInboxPage extends ConsumerStatefulWidget {
  const CommunicationInboxPage({super.key});
  @override
  ConsumerState<CommunicationInboxPage> createState() =>
      _CommunicationInboxPageState();
}

final class _CommunicationInboxPageState
    extends ConsumerState<CommunicationInboxPage> {
  List<ConversationSummary> items = [];
  bool loading = true;
  Object? error;
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    // Light polling fallback for the conversation list/unread badges — the
    // live WebSocket is reserved for the single currently-open conversation.
    _pollTimer = Timer.periodic(
      const Duration(seconds: 20),
      (_) => _load(silent: true),
    );
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) {
      setState(() {
        loading = true;
        error = null;
      });
    }
    try {
      final result = await ref
          .read(communicationRepositoryProvider)
          .conversations();
      if (!mounted) return;
      setState(() {
        items = result.items;
        loading = false;
        error = null;
      });
    } on Object catch (value) {
      if (!mounted || silent) return;
      setState(() {
        error = value;
        loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    // A foreground `communication.message.created` push is only ever a
    // "refresh from the server" hint (Prompt 15 §U) — never an independent
    // unread-count increment — so it is safe to fire even when the live
    // WebSocket already delivered the same event to an open conversation.
    ref.listen(
      communicationRefreshSignalProvider,
      (_, _) => _load(silent: true),
    );
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          if (error != null && items.isEmpty)
            AppErrorState(
              message: l10n.conversationsUnavailable,
              onRetry: _load,
            )
          else if (loading && items.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.xl),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (items.isEmpty)
            AppEmptyState(
              message: l10n.noConversations,
              icon: Icons.chat_bubble_outline,
            )
          else
            for (final item in items) ...[
              _ConversationTile(
                conversation: item,
                onTap: () => context.push('/messages/${item.id}'),
              ),
              const SizedBox(height: AppSpacing.sm),
            ],
        ],
      ),
    );
  }
}

final class _ConversationTile extends StatelessWidget {
  const _ConversationTile({required this.conversation, this.onTap});
  final ConversationSummary conversation;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).toLanguageTag();
    final timestamp = conversation.lastMessageAt == null
        ? null
        : intl.DateFormat.MMMd(
            locale,
          ).add_jm().format(conversation.lastMessageAt!);
    return Card(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const CircleAvatar(child: Icon(Icons.person_outline)),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      conversation.displayTitle(),
                      style: Theme.of(context).textTheme.titleMedium,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    if (conversation.lastMessageWasVoice)
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.mic, size: 16),
                          const SizedBox(width: AppSpacing.xs),
                          Text(l10n.voiceMessageLabel),
                        ],
                      )
                    else if (conversation.lastMessagePreview != null)
                      Text(
                        conversation.lastMessagePreview!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  if (timestamp != null)
                    Text(
                      timestamp,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  const SizedBox(height: AppSpacing.xs),
                  if (conversation.unreadCount > 0)
                    Badge(
                      label: Text(
                        conversation.unreadCount > 99
                            ? '99+'
                            : '${conversation.unreadCount}',
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

enum _VoiceComposerState {
  idle,
  permissionDenied,
  recording,
  preview,
  uploading,
  error,
}

final class ConversationPage extends ConsumerStatefulWidget {
  const ConversationPage({required this.conversationId, super.key});
  final String conversationId;
  @override
  ConsumerState<ConversationPage> createState() => _ConversationPageState();
}

final class _ConversationPageState extends ConsumerState<ConversationPage>
    implements CommunicationRealtimeHandlers {
  List<ConversationMessage> messages = [];
  bool loading = true;
  Object? error;
  String? _olderCursor;
  ConversationSummary? _summary;

  final _textController = TextEditingController();
  bool _sendingText = false;

  CommunicationRealtimeConnection? _realtime;
  StreamSubscription<VoicePlaybackStatus>? _playerSub;
  VoicePlaybackStatus _playerStatus = const VoicePlaybackStatus(
    state: VoicePlaybackState.idle,
    position: Duration.zero,
    duration: Duration.zero,
  );
  final Map<String, Object> _mediaCache = {}; // messageId -> bytes or error
  final Set<String> _mediaLoading = {};

  _VoiceComposerState _voiceState = _VoiceComposerState.idle;
  Timer? _recordingTimer;
  Duration _recordingElapsed = Duration.zero;
  VoiceRecording? _pendingRecording;
  String? _pendingClientMessageId;
  String? _pendingIdempotencyKey;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    unawaited(_connectRealtime());
    _playerSub = ref.read(voicePlayerProvider).status.listen((status) {
      if (!mounted) return;
      setState(() => _playerStatus = status);
    });
  }

  @override
  void dispose() {
    _recordingTimer?.cancel();
    _playerSub?.cancel();
    unawaited(_realtime?.close());
    _textController.dispose();
    super.dispose();
  }

  Future<void> _connectRealtime() async {
    // The live socket is a real-time enhancement layered on top of the REST
    // timeline — any failure here (storage, permissions, connectivity) must
    // never block the conversation from loading and working over REST alone.
    try {
      final token = await ref
          .read(storageProvider)
          .read(SensitiveKey.accessToken);
      if (token == null || !mounted) return;
      final apiBaseUrl = ref.read(configurationProvider).apiBaseUrl;
      final url = communicationRealtimeUrl(
        apiBaseUrl: apiBaseUrl,
        conversationId: widget.conversationId,
        accessToken: token,
      );
      _realtime = CommunicationRealtimeConnection(url: url, handlers: this)
        ..connect();
    } on Object {
      // Deliberately swallowed — see comment above.
    }
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final page = await ref
          .read(communicationRepositoryProvider)
          .messages(widget.conversationId);
      var conversations = const <ConversationSummary>[];
      try {
        conversations =
            (await ref
                    .read(communicationRepositoryProvider)
                    .conversations(limit: 100))
                .items;
      } on Object {
        // The conversation header (participant/order name) is a nice-to-have
        // — a failure here must never block the message timeline itself.
      }
      if (!mounted) return;
      setState(() {
        messages = page.items;
        _olderCursor = page.nextCursor;
        _summary = conversations.cast<ConversationSummary?>().firstWhere(
          (c) => c?.id == widget.conversationId,
          orElse: () => null,
        );
        loading = false;
      });
      await _markReadThroughLatest();
    } on Object catch (value) {
      if (!mounted) return;
      setState(() {
        error = value;
        loading = false;
      });
    }
  }

  Future<void> _loadOlder() async {
    final cursor = _olderCursor;
    if (cursor == null) return;
    try {
      final page = await ref
          .read(communicationRepositoryProvider)
          .messages(widget.conversationId, before: cursor);
      if (!mounted) return;
      final existing = messages.map((m) => m.id).toSet();
      setState(() {
        messages = [
          ...page.items.where((m) => existing.add(m.id)),
          ...messages,
        ];
        _olderCursor = page.nextCursor;
      });
    } on Object {
      // Older-history pagination failures are non-fatal — the visible
      // timeline is left untouched and the user can retry the tap.
    }
  }

  Future<void> _markReadThroughLatest() async {
    if (messages.isEmpty) return;
    try {
      await ref
          .read(communicationRepositoryProvider)
          .markRead(widget.conversationId, messages.last.id);
    } on Object {
      // Read-receipt failures must never block the conversation from
      // rendering — it will be retried on the next successful load.
    }
  }

  Future<void> _refreshLatestMessages() async {
    try {
      final page = await ref
          .read(communicationRepositoryProvider)
          .messages(widget.conversationId);
      if (!mounted) return;
      final existing = messages.map((m) => m.id).toSet();
      final incoming = page.items.where((m) => existing.add(m.id)).toList();
      if (incoming.isEmpty) return;
      setState(() {
        messages = [...messages, ...incoming]
          ..sort((a, b) => a.sequence.compareTo(b.sequence));
      });
      await _markReadThroughLatest();
    } on Object {
      // A missed live refresh self-heals on the next event or manual pull.
    }
  }

  @override
  void onEvent(CommunicationRealtimeEvent event) {
    if (event.type.startsWith('message')) {
      unawaited(_refreshLatestMessages());
    }
  }

  @override
  void onFullRefreshRequired() {
    unawaited(_load());
  }

  @override
  void onStatusChange(CommunicationRealtimeStatus status) {
    // Connection status is not surfaced in this screen — a dropped socket
    // self-heals via automatic reconnect, and messages are re-verified on
    // every successful (re)connect via the recovery replay.
  }

  void _showSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _sendText() async {
    final l10n = AppLocalizations.of(context);
    final body = _textController.text;
    final draft = OutgoingTextMessage(
      conversationId: widget.conversationId,
      clientMessageId: const Uuid().v4(),
      idempotencyKey: const Uuid().v4(),
      originalClientTime: DateTime.now().toUtc(),
      body: body,
    );
    if (draft.validationError(
          backendMaximumLength: communicationTextMaxLength,
        ) !=
        null) {
      return;
    }
    setState(() => _sendingText = true);
    try {
      final sent = await ref
          .read(communicationRepositoryProvider)
          .sendText(draft);
      if (!mounted) return;
      setState(() {
        if (!messages.any((m) => m.id == sent.id)) {
          messages = [...messages, sent];
        }
        _textController.clear();
        _sendingText = false;
      });
      unawaited(_markReadThroughLatest());
    } on Object {
      if (!mounted) return;
      setState(() => _sendingText = false);
      _showSnack(l10n.messageSendFailed);
    }
  }

  Future<void> _onMicTap() async {
    final recorder = ref.read(voiceRecorderProvider);
    bool granted;
    try {
      granted = await recorder.requestPermission();
    } on Object {
      granted = false;
    }
    if (!mounted) return;
    if (!granted) {
      setState(() => _voiceState = _VoiceComposerState.permissionDenied);
      return;
    }
    try {
      await recorder.start();
    } on Object {
      if (!mounted) return;
      _showSnack(AppLocalizations.of(context).recordingFailed);
      return;
    }
    if (!mounted) return;
    setState(() {
      _voiceState = _VoiceComposerState.recording;
      _recordingElapsed = Duration.zero;
    });
    _recordingTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      final next = _recordingElapsed + const Duration(seconds: 1);
      if (next.inSeconds >= VoiceMessageLimits.maxDurationSeconds) {
        unawaited(_onStopRecording(autoStopped: true));
        return;
      }
      setState(() => _recordingElapsed = next);
    });
  }

  Future<void> _onCancelRecording() async {
    _recordingTimer?.cancel();
    try {
      await ref.read(voiceRecorderProvider).cancel();
    } on Object {
      // Best effort — the composer still returns to idle either way.
    }
    if (!mounted) return;
    setState(() => _voiceState = _VoiceComposerState.idle);
  }

  Future<void> _onStopRecording({bool autoStopped = false}) async {
    _recordingTimer?.cancel();
    VoiceRecording? recording;
    try {
      recording = await ref.read(voiceRecorderProvider).stop();
    } on Object {
      recording = null;
    }
    if (!mounted) return;
    if (recording == null) {
      setState(() => _voiceState = _VoiceComposerState.idle);
      _showSnack(AppLocalizations.of(context).recordingFailed);
      return;
    }
    setState(() {
      _pendingRecording = recording;
      _pendingClientMessageId = const Uuid().v4();
      _pendingIdempotencyKey = const Uuid().v4();
      _voiceState = _VoiceComposerState.preview;
    });
    if (autoStopped) {
      _showSnack(
        AppLocalizations.of(context).maxRecordingDurationReachedNotice,
      );
    }
  }

  void _onDiscardPreview() {
    final path = _pendingRecording?.filePath;
    unawaited(ref.read(voicePlayerProvider).stop());
    setState(() {
      _pendingRecording = null;
      _pendingClientMessageId = null;
      _pendingIdempotencyKey = null;
      _voiceState = _VoiceComposerState.idle;
    });
    if (path != null) {
      unawaited(File(path).delete().catchError((_) => File(path)));
    }
  }

  Future<void> _onPreviewPlayback() async {
    final recording = _pendingRecording;
    if (recording == null) return;
    final player = ref.read(voicePlayerProvider);
    if (player.currentId == '_preview' &&
        _playerStatus.state == VoicePlaybackState.playing) {
      await player.pause();
      return;
    }
    if (player.currentId == '_preview' &&
        _playerStatus.state == VoicePlaybackState.paused) {
      await player.resume();
      return;
    }
    try {
      final bytes = await File(recording.filePath).readAsBytes();
      await player.playBytes('_preview', bytes);
    } on Object {
      if (!mounted) return;
      _showSnack(AppLocalizations.of(context).audioUnavailable);
    }
  }

  Future<void> _onSendVoice() async {
    final recording = _pendingRecording;
    final clientMessageId = _pendingClientMessageId;
    final idempotencyKey = _pendingIdempotencyKey;
    if (recording == null ||
        clientMessageId == null ||
        idempotencyKey == null) {
      return;
    }
    final outgoing = OutgoingVoiceMessage(
      conversationId: widget.conversationId,
      clientMessageId: clientMessageId,
      idempotencyKey: idempotencyKey,
      originalClientTime: DateTime.now().toUtc(),
      filePath: recording.filePath,
      durationSeconds: recording.durationSeconds,
      mimeType: recording.mimeType,
      sizeBytes: recording.sizeBytes,
    );
    final validation = outgoing.validationError();
    if (validation != null) {
      setState(() => _voiceState = _VoiceComposerState.error);
      _showSnack(_voiceErrorMessage(context, validation));
      return;
    }
    setState(() => _voiceState = _VoiceComposerState.uploading);
    try {
      final sent = await ref
          .read(communicationRepositoryProvider)
          .sendVoice(outgoing);
      if (!mounted) return;
      final path = recording.filePath;
      setState(() {
        if (!messages.any((m) => m.id == sent.id)) {
          messages = [...messages, sent];
        }
        _pendingRecording = null;
        _pendingClientMessageId = null;
        _pendingIdempotencyKey = null;
        _voiceState = _VoiceComposerState.idle;
      });
      unawaited(File(path).delete().catchError((_) => File(path)));
      unawaited(_markReadThroughLatest());
    } on Object catch (thrown) {
      if (!mounted) return;
      setState(() => _voiceState = _VoiceComposerState.error);
      _showSnack(_apiErrorMessage(context, thrown));
    }
  }

  Future<void> _onPlayVoiceMessage(ConversationMessage message) async {
    final player = ref.read(voicePlayerProvider);
    if (player.currentId == message.id &&
        _playerStatus.state == VoicePlaybackState.playing) {
      await player.pause();
      return;
    }
    if (player.currentId == message.id &&
        _playerStatus.state == VoicePlaybackState.paused) {
      await player.resume();
      return;
    }
    final cached = _mediaCache[message.id];
    if (cached is Uint8List) {
      await player.playBytes(message.id, cached);
      return;
    }
    if (_mediaLoading.contains(message.id)) return;
    setState(() => _mediaLoading.add(message.id));
    try {
      final bytes = await ref
          .read(communicationRepositoryProvider)
          .mediaBytes(message.id);
      _mediaCache[message.id] = bytes;
      if (!mounted) return;
      setState(() => _mediaLoading.remove(message.id));
      await player.playBytes(message.id, bytes);
    } on Object {
      if (!mounted) return;
      setState(() {
        _mediaLoading.remove(message.id);
        _mediaCache[message.id] = _mediaFetchFailed;
      });
      _showSnack(AppLocalizations.of(context).audioUnavailable);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final user = ref.watch(authenticationProvider).value?.user;
    final myParty = _partyForUser(user);
    return Column(
      children: [
        if (_summary != null)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.md,
              vertical: AppSpacing.sm,
            ),
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: Text(
                _summary!.displayTitle(),
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
          ),
        Expanded(child: _buildTimeline(context, l10n, myParty)),
        _Composer(
          controller: _textController,
          sending: _sendingText,
          onSend: _sendText,
          showMic: _canRecordVoice(user),
          voiceState: _voiceState,
          recordingElapsed: _recordingElapsed,
          pendingRecording: _pendingRecording,
          previewPlaying:
              ref.read(voicePlayerProvider).currentId == '_preview' &&
              _playerStatus.state == VoicePlaybackState.playing,
          onMicTap: _onMicTap,
          onStopRecording: () => _onStopRecording(),
          onCancelRecording: _onCancelRecording,
          onDiscardPreview: _onDiscardPreview,
          onSendVoice: _onSendVoice,
          onPreviewPlayback: _onPreviewPlayback,
        ),
      ],
    );
  }

  Widget _buildTimeline(
    BuildContext context,
    AppLocalizations l10n,
    ConversationParty? myParty,
  ) {
    if (error != null && messages.isEmpty) {
      return AppErrorState(message: l10n.dataUnavailable, onRetry: _load);
    }
    if (loading && messages.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (messages.isEmpty) {
      return AppEmptyState(message: l10n.noMessages, icon: Icons.chat_outlined);
    }
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        if (_olderCursor != null)
          Center(
            child: TextButton(
              onPressed: _loadOlder,
              child: Text(l10n.loadMore),
            ),
          ),
        for (final message in messages) ...[
          _MessageBubble(
            message: message,
            isMine: myParty != null && message.sender == myParty,
            mediaLoading: _mediaLoading.contains(message.id),
            mediaFailed: _mediaCache[message.id] == _mediaFetchFailed,
            isPlaying:
                ref.read(voicePlayerProvider).currentId == message.id &&
                _playerStatus.state == VoicePlaybackState.playing,
            playbackPosition:
                ref.read(voicePlayerProvider).currentId == message.id
                ? _playerStatus.position
                : Duration.zero,
            playbackDuration:
                ref.read(voicePlayerProvider).currentId == message.id &&
                    _playerStatus.duration > Duration.zero
                ? _playerStatus.duration
                : Duration(seconds: message.mediaDurationSeconds ?? 0),
            onPlay: () => _onPlayVoiceMessage(message),
          ),
          const SizedBox(height: AppSpacing.sm),
        ],
      ],
    );
  }
}

/// A distinct marker object (never a valid byte payload) recorded in the
/// media cache so a failed fetch is remembered without retrying on every
/// rebuild, while remaining trivially distinguishable from cached bytes.
const Object _mediaFetchFailed = Object();

String _voiceErrorMessage(BuildContext context, String code) {
  final l10n = AppLocalizations.of(context);
  return switch (code) {
    'voice_message_empty' => l10n.recordingFailed,
    'voice_message_too_large' => l10n.audioFileTooLarge,
    'voice_message_unsupported_type' => l10n.unsupportedAudioFormat,
    'voice_message_duration_invalid' => l10n.maxRecordingDurationReachedNotice,
    _ => l10n.voiceSendFailed,
  };
}

String _apiErrorMessage(BuildContext context, Object error) {
  if (error is ApiFailure &&
      (error.code?.startsWith('voice_message_') ?? false)) {
    return _voiceErrorMessage(context, error.code!);
  }
  return AppLocalizations.of(context).voiceSendFailed;
}

final class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.message,
    required this.isMine,
    required this.mediaLoading,
    required this.mediaFailed,
    required this.isPlaying,
    required this.playbackPosition,
    required this.playbackDuration,
    required this.onPlay,
  });
  final ConversationMessage message;
  final bool isMine, mediaLoading, mediaFailed, isPlaying;
  final Duration playbackPosition, playbackDuration;
  final VoidCallback onPlay;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    if (message.type == CommunicationMessageType.system) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
          child: Text(
            message.text ?? '',
            style: Theme.of(context).textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    final alignment = isMine ? Alignment.centerRight : Alignment.centerLeft;
    final color = isMine
        ? Theme.of(context).colorScheme.primaryContainer
        : Theme.of(context).colorScheme.surfaceContainerHighest;
    return Align(
      alignment: alignment,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.78,
        ),
        child: Container(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.sm,
            vertical: AppSpacing.sm,
          ),
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(14),
          ),
          child: message.isVoice
              ? _VoiceMessageContent(
                  message: message,
                  mediaLoading: mediaLoading,
                  mediaFailed: mediaFailed,
                  isPlaying: isPlaying,
                  position: playbackPosition,
                  duration: playbackDuration,
                  onPlay: onPlay,
                )
              : Text(message.text ?? l10n.voiceMessageLabel),
        ),
      ),
    );
  }
}

final class _VoiceMessageContent extends StatelessWidget {
  const _VoiceMessageContent({
    required this.message,
    required this.mediaLoading,
    required this.mediaFailed,
    required this.isPlaying,
    required this.position,
    required this.duration,
    required this.onPlay,
  });
  final ConversationMessage message;
  final bool mediaLoading, mediaFailed, isPlaying;
  final Duration position, duration;
  final VoidCallback onPlay;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    if (mediaFailed) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, size: 18),
          const SizedBox(width: AppSpacing.xs),
          Text(l10n.audioUnavailable),
        ],
      );
    }
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          tooltip: isPlaying ? l10n.pauseAction : l10n.playAction,
          onPressed: mediaLoading ? null : onPlay,
          icon: mediaLoading
              ? const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Icon(isPlaying ? Icons.pause_circle : Icons.play_circle),
        ),
        Text(_formatDuration(duration > Duration.zero ? duration : position)),
      ],
    );
  }
}

String _formatDuration(Duration duration) {
  final minutes = duration.inMinutes.remainder(60).toString().padLeft(2, '0');
  final seconds = duration.inSeconds.remainder(60).toString().padLeft(2, '0');
  return '$minutes:$seconds';
}

final class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.sending,
    required this.onSend,
    required this.showMic,
    required this.voiceState,
    required this.recordingElapsed,
    required this.pendingRecording,
    required this.previewPlaying,
    required this.onMicTap,
    required this.onStopRecording,
    required this.onCancelRecording,
    required this.onDiscardPreview,
    required this.onSendVoice,
    required this.onPreviewPlayback,
  });
  final TextEditingController controller;
  final bool sending;
  final VoidCallback onSend;
  final bool showMic;
  final _VoiceComposerState voiceState;
  final Duration recordingElapsed;
  final VoiceRecording? pendingRecording;
  final bool previewPlaying;
  final VoidCallback onMicTap;
  final VoidCallback onStopRecording;
  final VoidCallback onCancelRecording;
  final VoidCallback onDiscardPreview;
  final VoidCallback onSendVoice;
  final VoidCallback onPreviewPlayback;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: switch (voiceState) {
          _VoiceComposerState.recording => _RecordingBar(
            elapsed: recordingElapsed,
            onStop: onStopRecording,
            onCancel: onCancelRecording,
          ),
          _VoiceComposerState.preview ||
          _VoiceComposerState.uploading ||
          _VoiceComposerState.error => _VoicePreviewBar(
            uploading: voiceState == _VoiceComposerState.uploading,
            failed: voiceState == _VoiceComposerState.error,
            playing: previewPlaying,
            durationSeconds: pendingRecording?.durationSeconds ?? 0,
            onPlay: onPreviewPlayback,
            onDiscard: onDiscardPreview,
            onSend: onSendVoice,
          ),
          _VoiceComposerState.permissionDenied => _PermissionDeniedBar(
            onRetry: onMicTap,
          ),
          _VoiceComposerState.idle => Row(
            children: [
              Expanded(
                child: TextField(
                  key: const Key('conversationTextField'),
                  controller: controller,
                  minLines: 1,
                  maxLines: 4,
                  maxLength: communicationTextMaxLength,
                  buildCounter:
                      (
                        _, {
                        required currentLength,
                        required isFocused,
                        maxLength,
                      }) => null,
                  decoration: InputDecoration(
                    hintText: l10n.messageInputHint,
                    isDense: true,
                  ),
                ),
              ),
              if (showMic)
                IconButton(
                  key: const Key('conversationMicButton'),
                  tooltip: l10n.recordVoiceMessage,
                  onPressed: onMicTap,
                  icon: const Icon(Icons.mic),
                ),
              IconButton(
                key: const Key('conversationSendButton'),
                tooltip: l10n.sendMessage,
                onPressed: sending ? null : onSend,
                icon: sending
                    ? const SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.send),
              ),
            ],
          ),
        },
      ),
    );
  }
}

final class _RecordingBar extends StatelessWidget {
  const _RecordingBar({
    required this.elapsed,
    required this.onStop,
    required this.onCancel,
  });
  final Duration elapsed;
  final VoidCallback onStop, onCancel;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Row(
      children: [
        const Icon(Icons.fiber_manual_record, color: AppColors.error),
        const SizedBox(width: AppSpacing.sm),
        Text('${l10n.recordingInProgress} ${_formatDuration(elapsed)}'),
        const Spacer(),
        TextButton(
          key: const Key('conversationCancelRecordingButton'),
          onPressed: onCancel,
          child: Text(l10n.discardRecordingAction),
        ),
        FilledButton(
          key: const Key('conversationStopRecordingButton'),
          onPressed: onStop,
          child: Text(l10n.stopRecordingAction),
        ),
      ],
    );
  }
}

final class _VoicePreviewBar extends StatelessWidget {
  const _VoicePreviewBar({
    required this.uploading,
    required this.failed,
    required this.playing,
    required this.durationSeconds,
    required this.onPlay,
    required this.onDiscard,
    required this.onSend,
  });
  final bool uploading, failed, playing;
  final int durationSeconds;
  final VoidCallback onPlay, onDiscard, onSend;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (failed)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.xs),
            child: Text(
              l10n.voiceSendFailed,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        Row(
          children: [
            IconButton(
              key: const Key('conversationPreviewPlayButton'),
              onPressed: uploading ? null : onPlay,
              icon: Icon(playing ? Icons.pause_circle : Icons.play_circle),
            ),
            Text(_formatDuration(Duration(seconds: durationSeconds))),
            const Spacer(),
            TextButton(
              key: const Key('conversationDiscardVoiceButton'),
              onPressed: uploading ? null : onDiscard,
              child: Text(l10n.discardRecordingAction),
            ),
            FilledButton(
              key: const Key('conversationSendVoiceButton'),
              onPressed: uploading ? null : onSend,
              child: uploading
                  ? const SizedBox.square(
                      dimension: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text(failed ? l10n.retry : l10n.sendVoiceMessageAction),
            ),
          ],
        ),
      ],
    );
  }
}

final class _PermissionDeniedBar extends StatelessWidget {
  const _PermissionDeniedBar({required this.onRetry});
  final VoidCallback onRetry;
  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Semantics(
      liveRegion: true,
      child: Row(
        children: [
          const Icon(Icons.mic_off, color: AppColors.error),
          const SizedBox(width: AppSpacing.sm),
          Expanded(child: Text(l10n.microphonePermissionDenied)),
          TextButton(
            key: const Key('conversationRetryPermissionButton'),
            onPressed: onRetry,
            child: Text(l10n.retry),
          ),
        ],
      ),
    );
  }
}
