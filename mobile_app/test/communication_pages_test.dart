import 'dart:async';
import 'dart:typed_data';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_models.dart';
import 'package:bluelinegpt_mobile/core/auth/auth_service.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/services/push_notifications.dart';
import 'package:bluelinegpt_mobile/core/services/voice_io.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';
import 'package:bluelinegpt_mobile/features/communication/communication_models.dart';
import 'package:bluelinegpt_mobile/features/communication/communication_pages.dart';
import 'package:bluelinegpt_mobile/features/communication/communication_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

/// In-memory double for `CommunicationRepository` — the interface itself is
/// the seam, matching `FakeOperatorRepository` in
/// `operator_dashboard_and_detail_test.dart`.
final class FakeCommunicationRepository implements CommunicationRepository {
  ConversationListResult conversationsResult = const ConversationListResult(
    items: [],
  );
  int conversationsCalls = 0;
  MessageListResult messagesResult = const MessageListResult(items: []);
  int sendTextCalls = 0;
  int sendVoiceCalls = 0;
  int markReadCalls = 0;
  int mediaBytesCalls = 0;
  bool failNextVoiceSend = false;
  Object? sendVoiceError;
  Object? mediaBytesError;
  ConversationMessage? nextVoiceMessage;
  ConversationMessage? nextTextMessage;
  Uint8List mediaBytesResult = Uint8List.fromList([1, 2, 3]);
  final List<OutgoingVoiceMessage> voiceSendArgs = [];

  @override
  Future<ConversationListResult> conversations({
    String? cursor,
    int limit = 25,
    String? status,
    String? search,
    bool unreadOnly = false,
  }) async {
    conversationsCalls += 1;
    return conversationsResult;
  }

  @override
  Future<MessageListResult> messages(
    String conversationId, {
    String? before,
    String? after,
    int limit = 25,
  }) async => messagesResult;

  @override
  Future<ConversationMessage> sendText(OutgoingTextMessage message) async {
    sendTextCalls += 1;
    return nextTextMessage ??
        _message(
          id: 'text-$sendTextCalls',
          type: CommunicationMessageType.text,
          text: message.body,
        );
  }

  @override
  Future<ConversationMessage> sendVoice(OutgoingVoiceMessage message) async {
    sendVoiceCalls += 1;
    voiceSendArgs.add(message);
    if (failNextVoiceSend) {
      failNextVoiceSend = false;
      throw sendVoiceError ?? const ApiFailure(ApiFailureKind.server);
    }
    return nextVoiceMessage ??
        _message(
          id: 'voice-$sendVoiceCalls',
          type: CommunicationMessageType.voice,
          mediaDurationSeconds: message.durationSeconds,
        );
  }

  @override
  Future<int> markRead(String conversationId, String throughMessageId) async {
    markReadCalls += 1;
    return 0;
  }

  @override
  Future<UnreadSummary> unreadCount() async =>
      const UnreadSummary(unreadMessages: 0, unreadConversations: 0);

  @override
  Future<Uint8List> mediaBytes(String messageId) async {
    mediaBytesCalls += 1;
    if (mediaBytesError != null) throw mediaBytesError!;
    return mediaBytesResult;
  }

  static ConversationMessage _message({
    required String id,
    required CommunicationMessageType type,
    String? text,
    int? mediaDurationSeconds,
  }) => ConversationMessage(
    id: id,
    conversationId: 'conv-1',
    type: type,
    sender: ConversationParty.trader,
    sequence: 1,
    createdAt: DateTime.now(),
    text: text,
    mediaMimeType: type == CommunicationMessageType.voice ? 'audio/m4a' : null,
    mediaDurationSeconds: mediaDurationSeconds,
    mediaSizeBytes: type == CommunicationMessageType.voice ? 2048 : null,
  );
}

/// A small testable seam over the microphone — no platform channels needed.
final class FakeVoiceRecorder implements VoiceRecorder {
  bool permissionGranted = true;
  bool _recording = false;
  VoiceRecording? nextStopResult;
  int startCalls = 0;
  int stopCalls = 0;
  int cancelCalls = 0;

  @override
  Future<bool> hasPermission() async => permissionGranted;
  @override
  Future<bool> requestPermission() async => permissionGranted;
  @override
  bool get isRecording => _recording;
  @override
  Future<void> start() async {
    startCalls += 1;
    _recording = true;
  }

  @override
  Future<VoiceRecording?> stop() async {
    stopCalls += 1;
    _recording = false;
    return nextStopResult;
  }

  @override
  Future<void> cancel() async {
    cancelCalls += 1;
    _recording = false;
  }

  @override
  void dispose() {}
}

/// A small testable seam over playback.
final class FakeVoicePlayer implements VoicePlayer {
  final _controller = StreamController<VoicePlaybackStatus>.broadcast();
  String? _currentId;
  VoicePlaybackState _state = VoicePlaybackState.idle;
  final List<String> playedIds = [];

  @override
  Stream<VoicePlaybackStatus> get status => _controller.stream;
  @override
  String? get currentId => _currentId;

  void _emit() => _controller.add(
    VoicePlaybackStatus(
      state: _state,
      position: Duration.zero,
      duration: const Duration(seconds: 5),
    ),
  );

  @override
  Future<void> playBytes(String id, Uint8List bytes) async {
    _currentId = id;
    playedIds.add(id);
    _state = VoicePlaybackState.playing;
    _emit();
  }

  @override
  Future<void> pause() async {
    _state = VoicePlaybackState.paused;
    _emit();
  }

  @override
  Future<void> resume() async {
    _state = VoicePlaybackState.playing;
    _emit();
  }

  @override
  Future<void> seek(Duration position) async {}

  @override
  Future<void> stop() async {
    _currentId = null;
    _state = VoicePlaybackState.idle;
    _emit();
  }

  @override
  void dispose() => unawaited(_controller.close());
}

final class _FakeAuthenticationService implements AuthenticationService {
  _FakeAuthenticationService(this.state);
  final AuthenticationState state;
  @override
  Future<AuthenticationState> restore() async => state;
  @override
  Future<AuthenticationState> login(LoginInput input) async => state;
  @override
  Future<void> logout() async {}
  @override
  Future<String?> changePassword(
    String currentPassword,
    String newPassword,
  ) async => null;
}

AuthenticatedUser _traderUser() => AuthenticatedUser(
  id: 'trader-1',
  companyId: 'company-1',
  displayName: 'Test Trader',
  roles: {UserRole.trader},
  permissions: {},
  accessState: AccountAccessState.active,
);

AuthenticatedUser _customerUser() => AuthenticatedUser(
  id: 'customer-1',
  companyId: 'company-1',
  displayName: 'Test Customer',
  roles: {UserRole.customer},
  permissions: {},
  accessState: AccountAccessState.active,
);

AuthenticatedSession _sessionFor(AuthenticatedUser user) =>
    AuthenticatedSession(
      user: user,
      expiresAt: DateTime.now().toUtc().add(const Duration(hours: 1)),
    );

Widget _wrap(
  Widget child, {
  required FakeCommunicationRepository repository,
  required AuthenticatedUser user,
  FakeVoiceRecorder? recorder,
  FakeVoicePlayer? player,
}) => ProviderScope(
  overrides: [
    communicationRepositoryProvider.overrideWithValue(repository),
    voiceRecorderProvider.overrideWithValue(recorder ?? FakeVoiceRecorder()),
    voicePlayerProvider.overrideWithValue(player ?? FakeVoicePlayer()),
    storageProvider.overrideWithValue(MemorySensitiveStorage()),
    authenticationServiceProvider.overrideWithValue(
      _FakeAuthenticationService(
        AuthenticationState(
          AuthenticationStatus.authenticated,
          session: _sessionFor(user),
        ),
      ),
    ),
  ],
  child: MaterialApp(
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: const [
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    home: Scaffold(body: child),
  ),
);

void main() {
  group('ConversationPage — mic visibility', () {
    testWidgets('a Trader sees the mic button', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const ConversationPage(conversationId: 'conv-1'),
          repository: FakeCommunicationRepository(),
          user: _traderUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('conversationMicButton')), findsOneWidget);
    });

    testWidgets('a Customer does not see the mic button', (tester) async {
      await tester.pumpWidget(
        _wrap(
          const ConversationPage(conversationId: 'conv-1'),
          repository: FakeCommunicationRepository(),
          user: _customerUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('conversationMicButton')), findsNothing);
    });
  });

  group('ConversationPage — recording flow', () {
    testWidgets(
      'permission denial shows a retappable message and retrying can proceed',
      (tester) async {
        final recorder = FakeVoiceRecorder()..permissionGranted = false;
        await tester.pumpWidget(
          _wrap(
            const ConversationPage(conversationId: 'conv-1'),
            repository: FakeCommunicationRepository(),
            user: _traderUser(),
            recorder: recorder,
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('conversationMicButton')));
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('conversationRetryPermissionButton')),
          findsOneWidget,
        );

        recorder.permissionGranted = true;
        await tester.tap(
          find.byKey(const Key('conversationRetryPermissionButton')),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('conversationStopRecordingButton')),
          findsOneWidget,
        );
        // Clean up the running recorder timer before the test ends.
        await tester.tap(
          find.byKey(const Key('conversationCancelRecordingButton')),
        );
        await tester.pumpAndSettle();
      },
    );

    testWidgets('recording shows an elapsed timer and Stop moves to preview', (
      tester,
    ) async {
      final recorder = FakeVoiceRecorder()
        ..nextStopResult = const VoiceRecording(
          filePath: '/tmp/does-not-exist.m4a',
          durationSeconds: 3,
          mimeType: 'audio/m4a',
          sizeBytes: 500,
        );
      await tester.pumpWidget(
        _wrap(
          const ConversationPage(conversationId: 'conv-1'),
          repository: FakeCommunicationRepository(),
          user: _traderUser(),
          recorder: recorder,
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('conversationMicButton')));
      await tester.pumpAndSettle();
      expect(recorder.startCalls, 1);

      await tester.pump(const Duration(seconds: 2));
      expect(find.textContaining('00:02'), findsOneWidget);

      await tester.tap(
        find.byKey(const Key('conversationStopRecordingButton')),
      );
      await tester.pumpAndSettle();
      expect(recorder.stopCalls, 1);
      expect(
        find.byKey(const Key('conversationSendVoiceButton')),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const Key('conversationDiscardVoiceButton')));
      await tester.pumpAndSettle();
    });

    testWidgets(
      'cancelling mid-recording returns to idle without sending anything',
      (tester) async {
        final recorder = FakeVoiceRecorder();
        final repository = FakeCommunicationRepository();
        await tester.pumpWidget(
          _wrap(
            const ConversationPage(conversationId: 'conv-1'),
            repository: repository,
            user: _traderUser(),
            recorder: recorder,
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('conversationMicButton')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('conversationCancelRecordingButton')),
        );
        await tester.pumpAndSettle();
        expect(recorder.cancelCalls, 1);
        expect(repository.sendVoiceCalls, 0);
        expect(find.byKey(const Key('conversationMicButton')), findsOneWidget);
      },
    );

    testWidgets('discarding the preview returns to idle without sending', (
      tester,
    ) async {
      final recorder = FakeVoiceRecorder()
        ..nextStopResult = const VoiceRecording(
          filePath: '/tmp/does-not-exist.m4a',
          durationSeconds: 3,
          mimeType: 'audio/m4a',
          sizeBytes: 500,
        );
      final repository = FakeCommunicationRepository();
      await tester.pumpWidget(
        _wrap(
          const ConversationPage(conversationId: 'conv-1'),
          repository: repository,
          user: _traderUser(),
          recorder: recorder,
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('conversationMicButton')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('conversationStopRecordingButton')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('conversationDiscardVoiceButton')));
      await tester.pumpAndSettle();
      expect(repository.sendVoiceCalls, 0);
      expect(find.byKey(const Key('conversationMicButton')), findsOneWidget);
    });

    testWidgets(
      'a zero-length / failed recording is discarded without crashing',
      (tester) async {
        final recorder = FakeVoiceRecorder()..nextStopResult = null;
        await tester.pumpWidget(
          _wrap(
            const ConversationPage(conversationId: 'conv-1'),
            repository: FakeCommunicationRepository(),
            user: _traderUser(),
            recorder: recorder,
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('conversationMicButton')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('conversationStopRecordingButton')),
        );
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('conversationMicButton')), findsOneWidget);
        expect(
          find.byKey(const Key('conversationSendVoiceButton')),
          findsNothing,
        );
      },
    );

    testWidgets('sending a recorded voice message appends it to the timeline', (
      tester,
    ) async {
      final recorder = FakeVoiceRecorder()
        ..nextStopResult = const VoiceRecording(
          filePath: '/tmp/does-not-exist.m4a',
          durationSeconds: 4,
          mimeType: 'audio/m4a',
          sizeBytes: 500,
        );
      final repository = FakeCommunicationRepository();
      await tester.pumpWidget(
        _wrap(
          const ConversationPage(conversationId: 'conv-1'),
          repository: repository,
          user: _traderUser(),
          recorder: recorder,
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('conversationMicButton')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('conversationStopRecordingButton')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('conversationSendVoiceButton')));
      await tester.pumpAndSettle();

      expect(repository.sendVoiceCalls, 1);
      expect(find.byKey(const Key('conversationTextField')), findsOneWidget);
      expect(find.byIcon(Icons.play_circle), findsWidgets);
    });

    testWidgets(
      'a failed send can be retried, reusing the same clientMessageId and idempotencyKey',
      (tester) async {
        final recorder = FakeVoiceRecorder()
          ..nextStopResult = const VoiceRecording(
            filePath: '/tmp/does-not-exist.m4a',
            durationSeconds: 4,
            mimeType: 'audio/m4a',
            sizeBytes: 500,
          );
        final repository = FakeCommunicationRepository()
          ..failNextVoiceSend = true;
        await tester.pumpWidget(
          _wrap(
            const ConversationPage(conversationId: 'conv-1'),
            repository: repository,
            user: _traderUser(),
            recorder: recorder,
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('conversationMicButton')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('conversationStopRecordingButton')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('conversationSendVoiceButton')));
        await tester.pumpAndSettle();

        expect(repository.sendVoiceCalls, 1);
        final firstAttempt = repository.voiceSendArgs.single;

        // The failure SnackBar sits on top of the composer for its default
        // display duration — let it fully dismiss before tapping through it.
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const Key('conversationSendVoiceButton')));
        await tester.pumpAndSettle();

        expect(repository.sendVoiceCalls, 2);
        final secondAttempt = repository.voiceSendArgs[1];
        expect(secondAttempt.clientMessageId, firstAttempt.clientMessageId);
        expect(secondAttempt.idempotencyKey, firstAttempt.idempotencyKey);
      },
    );
  });

  group('ConversationPage — voice message playback', () {
    ConversationMessage voiceMessage({String id = 'voice-1'}) =>
        ConversationMessage(
          id: id,
          conversationId: 'conv-1',
          type: CommunicationMessageType.voice,
          sender: ConversationParty.office,
          sequence: 1,
          createdAt: DateTime.now(),
          mediaMimeType: 'audio/m4a',
          mediaDurationSeconds: 42,
          mediaSizeBytes: 999,
        );

    testWidgets('a voice message renders its duration and a play affordance', (
      tester,
    ) async {
      final repository = FakeCommunicationRepository()
        ..messagesResult = MessageListResult(items: [voiceMessage()]);
      await tester.pumpWidget(
        _wrap(
          const ConversationPage(conversationId: 'conv-1'),
          repository: repository,
          user: _traderUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.play_circle), findsOneWidget);
      expect(find.text('00:42'), findsOneWidget);
    });

    testWidgets(
      'tapping play fetches media once and toggles play/pause via the player',
      (tester) async {
        final repository = FakeCommunicationRepository()
          ..messagesResult = MessageListResult(items: [voiceMessage()]);
        final player = FakeVoicePlayer();
        await tester.pumpWidget(
          _wrap(
            const ConversationPage(conversationId: 'conv-1'),
            repository: repository,
            user: _traderUser(),
            player: player,
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byIcon(Icons.play_circle));
        await tester.pumpAndSettle();
        expect(repository.mediaBytesCalls, 1);
        expect(player.playedIds, ['voice-1']);
        expect(find.byIcon(Icons.pause_circle), findsOneWidget);

        await tester.tap(find.byIcon(Icons.pause_circle));
        await tester.pumpAndSettle();
        expect(find.byIcon(Icons.play_circle), findsOneWidget);

        await tester.tap(find.byIcon(Icons.play_circle));
        await tester.pumpAndSettle();
        // Resuming a paused, already-fetched clip must not re-fetch bytes.
        expect(repository.mediaBytesCalls, 1);
      },
    );

    testWidgets('a failed media fetch shows an error state without crashing', (
      tester,
    ) async {
      final repository = FakeCommunicationRepository()
        ..messagesResult = MessageListResult(items: [voiceMessage()])
        ..mediaBytesError = const ApiFailure(ApiFailureKind.forbidden);
      await tester.pumpWidget(
        _wrap(
          const ConversationPage(conversationId: 'conv-1'),
          repository: repository,
          user: _traderUser(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(Icons.play_circle));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('conversationTextField')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('CommunicationInboxPage', () {
    testWidgets('shows an empty state when there are no conversations', (
      tester,
    ) async {
      await tester.pumpWidget(
        _wrap(
          const CommunicationInboxPage(),
          repository: FakeCommunicationRepository(),
          user: _traderUser(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(CommunicationInboxPage), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'renders the localized voice marker instead of the raw preview string',
      (tester) async {
        final repository = FakeCommunicationRepository()
          ..conversationsResult = const ConversationListResult(
            items: [
              ConversationSummary(
                id: 'conv-9',
                party: ConversationParty.office,
                status: 'active',
                unreadCount: 2,
                participantName: 'Office Support',
                lastMessagePreview: 'voice_message',
              ),
            ],
          );
        await tester.pumpWidget(
          _wrap(
            const CommunicationInboxPage(),
            repository: repository,
            user: _traderUser(),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('voice_message'), findsNothing);
        expect(find.text('Voice message'), findsOneWidget);
        expect(find.text('2'), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('tapping a conversation navigates to its detail route', (
      tester,
    ) async {
      final repository = FakeCommunicationRepository()
        ..conversationsResult = const ConversationListResult(
          items: [
            ConversationSummary(
              id: 'conv-42',
              party: ConversationParty.office,
              status: 'active',
              unreadCount: 0,
              orderNumber: 'ORD-42',
            ),
          ],
        );
      final router = GoRouter(
        initialLocation: '/messages',
        routes: [
          GoRoute(
            path: '/messages',
            builder: (_, _) => const CommunicationInboxPage(),
          ),
          GoRoute(
            path: '/messages/:id',
            builder: (_, state) => Scaffold(
              body: Text('conversation:${state.pathParameters['id']}'),
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            communicationRepositoryProvider.overrideWithValue(repository),
            storageProvider.overrideWithValue(MemorySensitiveStorage()),
            authenticationServiceProvider.overrideWithValue(
              _FakeAuthenticationService(
                AuthenticationState(
                  AuthenticationStatus.authenticated,
                  session: _sessionFor(_traderUser()),
                ),
              ),
            ),
          ],
          child: MaterialApp.router(
            routerConfig: router,
            supportedLocales: AppLocalizations.supportedLocales,
            localizationsDelegates: const [
              AppLocalizations.delegate,
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('ORD-42'));
      await tester.pumpAndSettle();
      expect(find.text('conversation:conv-42'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'a foreground push refresh signal re-fetches from the server as a '
      'hint, never as an independent duplicate-count increment (Prompt 15 §U)',
      (tester) async {
        final repository = FakeCommunicationRepository()
          ..conversationsResult = const ConversationListResult(
            items: [
              ConversationSummary(
                id: 'conv-1',
                party: ConversationParty.office,
                status: 'active',
                unreadCount: 1,
              ),
            ],
          );
        await tester.pumpWidget(
          _wrap(
            const CommunicationInboxPage(),
            repository: repository,
            user: _traderUser(),
          ),
        );
        await tester.pumpAndSettle();
        final callsAfterInitialLoad = repository.conversationsCalls;
        expect(callsAfterInitialLoad, greaterThan(0));

        final container = ProviderScope.containerOf(
          tester.element(find.byType(CommunicationInboxPage)),
        );
        // Simulates a foreground `communication.message.created` push
        // arriving while a WebSocket connection could also be delivering
        // the same underlying event elsewhere — this signal only ever
        // triggers a fresh REST fetch (never a local counter bump), so
        // firing it (even more than once, as a real duplicate WebSocket +
        // FCM delivery of "the same" event would) can never double-count
        // anything: the list is always replaced wholesale from the server.
        container.read(communicationRefreshSignalProvider.notifier).state++;
        container.read(communicationRefreshSignalProvider.notifier).state++;
        await tester.pumpAndSettle();

        expect(
          repository.conversationsCalls,
          greaterThan(callsAfterInitialLoad),
        );
        // Still exactly one conversation shown — a "refresh" can never
        // duplicate rows, unlike an increment would.
        expect(find.byType(Card), findsOneWidget);
      },
    );
  });
}
