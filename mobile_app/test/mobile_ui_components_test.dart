import 'package:bluelinegpt_mobile/app/localization/app_localizations.dart';
import 'package:bluelinegpt_mobile/shared/models/mobile_ui_models.dart';
import 'package:bluelinegpt_mobile/shared/widgets/mobile_ui_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('status mapper is centralized and unknown fails safely', () {
    expect(
      OrderStatusMapper.parse('assigned'),
      OrderStatusPresentation.assigned,
    );
    expect(
      OrderStatusMapper.parse('processing'),
      OrderStatusPresentation.unknown,
    );
    expect(
      OrderStatusMapper.parse('surprise'),
      OrderStatusPresentation.unknown,
    );
  });

  testWidgets('summary card distinguishes zero and unavailable', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        Row(
          children: const [
            Expanded(
              child: SizedBox(
                height: 150,
                child: SummaryCard(
                  title: 'Zero',
                  icon: Icons.numbers,
                  value: 0,
                ),
              ),
            ),
            Expanded(
              child: SizedBox(
                height: 150,
                child: SummaryCard(title: 'Missing', icon: Icons.help_outline),
              ),
            ),
          ],
        ),
      ),
    );
    expect(find.text('0'), findsOneWidget);
    expect(find.text('Not available'), findsOneWidget);
  });

  testWidgets('badge is visible only for verified positive count', (
    tester,
  ) async {
    await tester.pumpWidget(
      _app(
        const Row(
          children: [
            UnreadBadgeIcon(icon: Icons.notifications, count: 3),
            UnreadBadgeIcon(icon: Icons.chat),
          ],
        ),
      ),
    );
    expect(find.text('3'), findsOneWidget);
    expect(find.text('0'), findsNothing);
  });

  testWidgets('Arabic status chip and RTL render', (tester) async {
    await tester.pumpWidget(
      _app(const StatusChip(status: 'delivered'), locale: const Locale('ar')),
    );
    expect(find.text('تم التوصيل'), findsOneWidget);
    expect(
      Directionality.of(tester.element(find.text('تم التوصيل'))),
      TextDirection.rtl,
    );
  });

  testWidgets('Driver Order card hides Trader financial fields', (
    tester,
  ) async {
    const order = OrderCardModel(
      orderNumber: 'BL-100',
      status: 'assigned',
      customerName: 'Customer',
      mobileNumber: '+971501234567',
      cod: '120.00',
      deliveryFee: '10.00',
      netExpected: '110.00',
    );
    await tester.pumpWidget(
      _app(const OrderCard(order: order, audience: OrderAudience.driver)),
    );
    expect(find.textContaining('Customer'), findsOneWidget);
    expect(find.textContaining('120.00'), findsNothing);
    expect(find.textContaining('10.00'), findsNothing);
  });

  testWidgets('search debounces and limits long pasted input', (tester) async {
    String? query;
    await tester.pumpWidget(
      _app(AppSearchField(onChanged: (value) => query = value)),
    );
    await tester.enterText(find.byType(TextField), 'x' * 400);
    await tester.pump(const Duration(milliseconds: 400));
    expect(query?.length, 200);
  });

  testWidgets('responsive summary grid does not overflow on a small phone', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      _app(
        const SingleChildScrollView(
          child: ResponsiveSummaryGrid(
            children: [
              SummaryCard(
                title: 'A very long localized dashboard title',
                icon: Icons.home,
              ),
              SummaryCard(title: 'Second title', icon: Icons.list),
            ],
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
  });
}

Widget _app(Widget child, {Locale locale = const Locale('en')}) => MaterialApp(
  locale: locale,
  supportedLocales: AppLocalizations.supportedLocales,
  localizationsDelegates: const [
    AppLocalizations.delegate,
    GlobalMaterialLocalizations.delegate,
    GlobalWidgetsLocalizations.delegate,
    GlobalCupertinoLocalizations.delegate,
  ],
  home: Scaffold(body: child),
);
