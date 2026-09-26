import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart' as ap;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart' as rec;

/// A finished recording ready to be previewed/uploaded.
final class VoiceRecording {
  const VoiceRecording({
    required this.filePath,
    required this.durationSeconds,
    required this.mimeType,
    required this.sizeBytes,
  });
  final String filePath;
  final int durationSeconds;
  final String mimeType;
  final int sizeBytes;
}

/// A small, testable seam over the platform microphone. Widget tests inject
/// a fake implementation — the real `record`-package-backed implementation
/// needs platform channels that don't exist in the test environment.
abstract interface class VoiceRecorder {
  Future<bool> hasPermission();
  Future<bool> requestPermission();
  bool get isRecording;
  Future<void> start();

  /// Stops the current recording. Returns `null` if nothing usable was
  /// captured (e.g. zero-length) rather than throwing — callers must treat
  /// that as a silent discard, never a crash.
  Future<VoiceRecording?> stop();
  Future<void> cancel();
  void dispose();
}

/// `record` produces AAC-in-M4A on both Android and iOS — the MIME type the
/// backend accepts (`audio/m4a`, `audio/mp4`, `audio/x-m4a`, `audio/aac`).
const String recordedVoiceMimeType = 'audio/m4a';

final class RecordPackageVoiceRecorder implements VoiceRecorder {
  RecordPackageVoiceRecorder() : _recorder = rec.AudioRecorder();
  final rec.AudioRecorder _recorder;
  DateTime? _startedAt;
  String? _path;

  @override
  Future<bool> hasPermission() => _recorder.hasPermission(request: false);

  @override
  Future<bool> requestPermission() => _recorder.hasPermission();

  @override
  bool get isRecording => _startedAt != null;

  @override
  Future<void> start() async {
    final directory = await getTemporaryDirectory();
    final path =
        '${directory.path}/voice-${DateTime.now().microsecondsSinceEpoch}.m4a';
    await _recorder.start(
      const rec.RecordConfig(encoder: rec.AudioEncoder.aacLc),
      path: path,
    );
    _path = path;
    _startedAt = DateTime.now();
  }

  @override
  Future<VoiceRecording?> stop() async {
    final startedAt = _startedAt;
    final path = await _recorder.stop();
    final effectivePath = path ?? _path;
    final elapsed = startedAt == null
        ? 0
        : DateTime.now().difference(startedAt).inSeconds;
    _startedAt = null;
    _path = null;
    if (effectivePath == null) return null;
    final file = File(effectivePath);
    if (!await file.exists()) return null;
    final size = await file.length();
    if (size <= 0) return null;
    return VoiceRecording(
      filePath: effectivePath,
      durationSeconds: elapsed.clamp(1, 300),
      mimeType: recordedVoiceMimeType,
      sizeBytes: size,
    );
  }

  @override
  Future<void> cancel() async {
    if (_startedAt == null) return;
    final path = await _recorder.stop();
    _startedAt = null;
    final effectivePath = path ?? _path;
    _path = null;
    if (effectivePath != null) {
      final file = File(effectivePath);
      if (await file.exists()) await file.delete();
    }
  }

  @override
  void dispose() {
    unawaited(_recorder.dispose());
  }
}

enum VoicePlaybackState { idle, loading, playing, paused, completed, error }

final class VoicePlaybackStatus {
  const VoicePlaybackStatus({
    required this.state,
    required this.position,
    required this.duration,
  });
  final VoicePlaybackState state;
  final Duration position;
  final Duration duration;
}

/// A small, testable seam over the platform audio player — one instance is
/// shared per conversation screen so at most one voice item plays at a time.
abstract interface class VoicePlayer {
  Stream<VoicePlaybackStatus> get status;
  Future<void> playBytes(String id, Uint8List bytes);
  Future<void> pause();
  Future<void> resume();
  Future<void> seek(Duration position);
  Future<void> stop();
  String? get currentId;
  void dispose();
}

final class AudioPlayersVoicePlayer implements VoicePlayer {
  AudioPlayersVoicePlayer() : _player = ap.AudioPlayer() {
    _player.onPlayerStateChanged.listen(_onPlayerState);
    _player.onPositionChanged.listen((position) {
      _position = position;
      _emit();
    });
    _player.onDurationChanged.listen((duration) {
      _duration = duration;
      _emit();
    });
  }

  final ap.AudioPlayer _player;
  final _controller = StreamController<VoicePlaybackStatus>.broadcast();
  String? _currentId;
  Duration _position = Duration.zero;
  Duration _duration = Duration.zero;
  VoicePlaybackState _state = VoicePlaybackState.idle;

  @override
  Stream<VoicePlaybackStatus> get status => _controller.stream;

  @override
  String? get currentId => _currentId;

  void _onPlayerState(ap.PlayerState playerState) {
    _state = switch (playerState) {
      ap.PlayerState.playing => VoicePlaybackState.playing,
      ap.PlayerState.paused => VoicePlaybackState.paused,
      ap.PlayerState.completed => VoicePlaybackState.completed,
      ap.PlayerState.stopped => VoicePlaybackState.idle,
      ap.PlayerState.disposed => VoicePlaybackState.idle,
    };
    if (_state == VoicePlaybackState.completed) _position = _duration;
    _emit();
  }

  void _emit() {
    if (_controller.isClosed) return;
    _controller.add(
      VoicePlaybackStatus(
        state: _state,
        position: _position,
        duration: _duration,
      ),
    );
  }

  @override
  Future<void> playBytes(String id, Uint8List bytes) async {
    _currentId = id;
    _position = Duration.zero;
    _duration = Duration.zero;
    _state = VoicePlaybackState.loading;
    _emit();
    try {
      await _player.play(ap.BytesSource(bytes));
    } on Object {
      _state = VoicePlaybackState.error;
      _emit();
      rethrow;
    }
  }

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> resume() => _player.resume();

  @override
  Future<void> seek(Duration position) => _player.seek(position);

  @override
  Future<void> stop() async {
    await _player.stop();
    _currentId = null;
    _position = Duration.zero;
    _state = VoicePlaybackState.idle;
    _emit();
  }

  @override
  void dispose() {
    unawaited(_controller.close());
    unawaited(_player.dispose());
  }
}
