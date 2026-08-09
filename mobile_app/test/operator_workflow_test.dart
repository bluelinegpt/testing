import 'package:bluelinegpt_mobile/features/operator_workflow/operator_models.dart';
import 'package:bluelinegpt_mobile/features/operator_workflow/operator_pages.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Operator Order access requires a verified backend permission', () {
    expect(hasOperatorOrderAccess({'orders.assign_driver'}), isTrue);
    expect(hasOperatorOrderAccess({'orders.update_delivery_status'}), isTrue);
    expect(hasOperatorOrderAccess({'mobile.operator.access'}), isFalse);
    expect(hasOperatorOrderAccess({}), isFalse);
  });
  test('pagination uses server totals', () {
    const first = OperatorOrderPage(
      items: [],
      page: 1,
      pageSize: 25,
      totalCount: 26,
    );
    const last = OperatorOrderPage(
      items: [],
      page: 2,
      pageSize: 25,
      totalCount: 26,
    );
    expect(first.hasMore, isTrue);
    expect(last.hasMore, isFalse);
  });
  test('only active Drivers are eligible in mobile assignment selector', () {
    const active = OperatorDriver(
      id: '1',
      name: 'A',
      status: 'active',
      type: 'employee',
      activeOrders: 0,
    );
    const inactive = OperatorDriver(
      id: '2',
      name: 'B',
      status: 'inactive',
      type: 'employee',
      activeOrders: 0,
    );
    expect(active.eligible, isTrue);
    expect(inactive.eligible, isFalse);
  });
  test('Operator permissions exclude finance-only access by default', () {
    expect(operatorOrderPermissions, isNot(contains('reports.financial.view')));
    expect(operatorOrderPermissions, isNot(contains('settlements.view')));
  });
}
