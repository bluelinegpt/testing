import 'dart:convert';

import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/app/providers.dart';
import 'package:bluelinegpt_mobile/core/network/api_client.dart';
import 'package:bluelinegpt_mobile/core/storage/app_storage.dart';
import 'package:bluelinegpt_mobile/features/driver/route/route_models.dart';
import 'package:bluelinegpt_mobile/features/driver/route/route_pages.dart';
import 'package:bluelinegpt_mobile/features/driver/route/route_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/driver_offline_fakes.dart';

Map<String, dynamic> _runJson({int revision = 1, String resultSource = 'provider', List<String> deferred = const []}) => {
  'id': 'run-1',
  'referenceNumber': 'RUN-000001',
  'businessDate': '2026-10-10',
  'revision': revision,
  'direction': 'recommended',
  'resultSource': resultSource,
  'fallbackReason': resultSource == 'provider' ? null : 'kill_switch',
  'partialOptimization': false,
  'distanceMeters': 12300,
  'durationSeconds': 2100,
  'nextAreaId': 'area-ajm',
  'cashHandoverOrderCount': 1,
  'areas': [
    {
      'areaId': 'area-ajm',
      'areaNameEn': 'Al Nuaimiya',
      'areaNameAr': 'النعيمية',
      'emirateNameEn': 'Ajman',
      'emirateNameAr': 'عجمان',
      'sequencePosition': 1,
      'isSequenced': true,
      'isNew': false,
      'status': 'pending',
      'orderCount': 1,
      'cashHandoverCount': 0,
      'latitude': 25.392,
      'longitude': 55.453,
      'orders': [
        {'id': 'order-1', 'orderNumber': 'ORD-000001', 'customerName': 'Customer A', 'deliveryStatus': 'assigned_to_driver'},
      ],
    },
    {
      'areaId': 'area-shj',
      'areaNameEn': 'Al Nahda',
      'emirateNameEn': 'Sharjah',
      'sequencePosition': 2,
      'isSequenced': true,
      'status': 'done',
      'orderCount': 0,
      'cashHandoverCount': 1,
      'orders': [],
    },
  ],
  'deferredOrders': [
    for (final id in deferred) {'id': id, 'orderNumber': 'ORD-$id', 'customerName': 'Deferred $id'},
  ],
};

final class _FakeRoutes implements DriverRouteRepository {
  _FakeRoutes(this.state);
  RouteState state;
  final List<String> calls = [];
  final Set<String> keys = {};

  @override
  Future<RouteState> current() async {
    calls.add('current');
    return state;
  }

  @override
  Future<RouteState> plan(String idempotencyKey, {String? startAreaId}) async {
    calls.add('plan');
    keys.add(idempotencyKey);
    return state = RouteState.fromJson({'enabled': true, 'run': _runJson()});
  }

  @override
  Future<RouteState> replan(String idempotencyKey, int expectedRevision, {String? startAreaId}) async {
    calls.add('replan:$expectedRevision');
    return state;
  }

  @override
  Future<RouteState> reverse(String idempotencyKey, int expectedRevision) async {
    calls.add('reverse:$expectedRevision');
    return state = RouteState.fromJson({'enabled': true, 'run': _runJson(revision: expectedRevision + 1)});
  }

  @override
  Future<RouteState> defer(String idempotencyKey, String orderId, int expectedRevision) async {
    calls.add('defer:$orderId:$expectedRevision');
    return state = RouteState.fromJson({
      'enabled': true,
      'run': _runJson(revision: expectedRevision + 1, deferred: [orderId]),
    });
  }
}

Widget _wrap(Widget child, DriverRouteRepository routes, {Locale locale = const Locale('en')}) => ProviderScope(
  overrides: [driverRouteRepositoryProvider.overrideWithValue(routes)],
  child: MaterialApp(
    locale: locale,
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

void _tall(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  group('route models', () {
    test('parse leniently: odd optional fields never fail the route', () {
      final state = RouteState.fromJson({
        'enabled': true,
        'run': {
          ..._runJson(),
          'distanceMeters': 'not-a-number',
          'areas': [
            {'areaId': 'x', 'orderCount': '3', 'latitude': '25.1', 'orders': 'oops'},
            'garbage',
          ],
        },
      });
      final area = state.run!.areas.single;
      expect(area.orderCount, 3);
      expect(area.latitude, 25.1);
      expect(area.hasPin, isFalse);
      expect(area.orders, isEmpty);
      expect(state.run!.distanceMeters, 0);
    });

    test('round-trips through JSON for the offline copy', () {
      final state = RouteState.fromJson({'enabled': true, 'run': _runJson(deferred: ['o9'])});
      final again = RouteState.fromJson(jsonDecode(jsonEncode(state.toJson())) as Map<String, dynamic>);
      expect(again.run!.areas.map((a) => a.areaId), ['area-ajm', 'area-shj']);
      expect(again.run!.deferredOrders.single.id, 'o9');
      expect(again.run!.nextArea!.areaNameEn, 'Al Nuaimiya');
    });
  });

  group('offline copy', () {
    test('serves the saved route when the network is down, the same day only', () async {
      final storage = MemorySensitiveStorage();
      final online = _FakeRoutes(RouteState.fromJson({'enabled': true, 'run': _runJson()}));
      var now = DateTime(2026, 10, 10, 9);
      await CachedDriverRouteRepository(inner: online, storage: storage, clock: () => now).current();

      final offline = CachedDriverRouteRepository(
        inner: _Failing(const ApiFailure(ApiFailureKind.network)),
        storage: storage,
        clock: () => now,
      );
      final cached = await offline.current();
      expect(cached.offline, isTrue);
      expect(cached.run!.referenceNumber, 'RUN-000001');

      now = DateTime(2026, 10, 11, 9);
      await expectLater(offline.current(), throwsA(isA<ApiFailure>()));
    });

    test('never serves a saved route for a refused request', () async {
      final storage = MemorySensitiveStorage();
      await CachedDriverRouteRepository(
        inner: _FakeRoutes(RouteState.fromJson({'enabled': true, 'run': _runJson()})),
        storage: storage,
      ).current();
      final refused = CachedDriverRouteRepository(
        inner: _Failing(const ApiFailure(ApiFailureKind.forbidden)),
        storage: storage,
      );
      await expectLater(refused.current(), throwsA(isA<ApiFailure>()));
    });

    test('is session data, cleared on logout', () async {
      final storage = MemorySensitiveStorage();
      await storage.write(SensitiveKey.driverRouteCache, '{}');
      await storage.clearSession();
      expect(await storage.read(SensitiveKey.driverRouteCache), isNull);
    });
  });

  group('Orders screen tabs', () {
    Widget tabs(bool enabled) => ProviderScope(
      overrides: [
        driverRouteRepositoryProvider.overrideWithValue(_FakeRoutes(RouteState(enabled: enabled))),
        driverRepositoryProvider.overrideWithValue(ScriptedApiDriverRepository()),
      ],
      child: MaterialApp(
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: const Scaffold(body: DriverOrdersWithRouteTabs()),
      ),
    );

    testWidgets('no tabs when route planning is off: the plain Orders list', (tester) async {
      await tester.pumpWidget(tabs(false));
      await tester.pumpAndSettle();
      expect(find.byType(TabBar), findsNothing);
    });

    testWidgets('My Orders and Route tabs when route planning is on', (tester) async {
      await tester.pumpWidget(tabs(true));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(Tab, 'My Orders'), findsOneWidget);
      expect(find.widgetWithText(Tab, 'Route'), findsOneWidget);
    });
  });

  group('Route tab', () {
    testWidgets('plans a route, shows the Area sequence and defers an Order', (tester) async {
      _tall(tester);
      final routes = _FakeRoutes(const RouteState(enabled: true));
      await tester.pumpWidget(_wrap(const DriverRoutePage(initial: RouteState(enabled: true)), routes));
      await tester.tap(find.text('Plan my route'));
      await tester.pumpAndSettle();
      expect(routes.calls, contains('plan'));
      expect(routes.keys.single.length, greaterThanOrEqualTo(8));
      expect(find.text('Next Area'), findsOneWidget);
      expect(find.text('Al Nuaimiya'), findsWidgets);

      await tester.tap(find.text('Al Nuaimiya').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Defer'));
      await tester.pumpAndSettle();
      expect(routes.calls, contains('defer:order-1:1'));
      expect(find.text('Deferred to the end'), findsOneWidget);
    });

    testWidgets('reverse sends the shown revision; a fallback route says so', (tester) async {
      _tall(tester);
      final routes = _FakeRoutes(RouteState.fromJson({'enabled': true, 'run': _runJson(resultSource: 'fallback')}));
      await tester.pumpWidget(_wrap(DriverRoutePage(initial: routes.state), routes));
      expect(find.text('This is a standard Area order, not an optimized route.'), findsOneWidget);
      await tester.tap(find.text('Reverse direction'));
      await tester.pumpAndSettle();
      expect(routes.calls, contains('reverse:1'));
    });

    testWidgets('a saved offline route disables changes', (tester) async {
      _tall(tester);
      final offline = RouteState.fromJson({'enabled': true, 'run': _runJson()}, offline: true);
      final routes = _FakeRoutes(offline);
      await tester.pumpWidget(_wrap(DriverRoutePage(initial: offline), routes));
      expect(find.textContaining('Offline'), findsOneWidget);
      final replan = tester.widget<OutlinedButton>(find.widgetWithText(OutlinedButton, 'Replan'));
      expect(replan.onPressed, isNull);
    });

    testWidgets('renders in Arabic', (tester) async {
      _tall(tester);
      final state = RouteState.fromJson({'enabled': true, 'run': _runJson()});
      await tester.pumpWidget(_wrap(DriverRoutePage(initial: state), _FakeRoutes(state), locale: const Locale('ar')));
      expect(find.text('النعيمية'), findsWidgets);
      expect(find.text('عكس الاتجاه'), findsOneWidget);
    });
  });
}

final class _Failing implements DriverRouteRepository {
  _Failing(this.error);
  final Object error;
  @override
  Future<RouteState> current() async => throw error;
  @override
  Future<RouteState> plan(String idempotencyKey, {String? startAreaId}) async => throw error;
  @override
  Future<RouteState> replan(String idempotencyKey, int expectedRevision, {String? startAreaId}) async => throw error;
  @override
  Future<RouteState> reverse(String idempotencyKey, int expectedRevision) async => throw error;
  @override
  Future<RouteState> defer(String idempotencyKey, String orderId, int expectedRevision) async => throw error;
}
