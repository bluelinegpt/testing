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
  test(
      'A Driver User holding only orders.driver_self_service (the standard '
      'Driver role) can open the Orders surface — the backend scopes it to '
      'their own assigned Orders', () {
    expect(hasOperatorOrderAccess({'orders.driver_self_service'}), isTrue);
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

  group('operatorSelectableStatusTargets (Prompt 12B)', () {
    test(
      'New Order can only be Cancelled — Assign to Driver is a separate action',
      () {
        expect(operatorSelectableStatusTargets('new'), ['cancelled']);
      },
    );
    test(
      'In-Branch is internal only and offers no user-facing forward move',
      () {
        expect(operatorSelectableStatusTargets('in_branch'), ['cancelled']);
      },
    );
    test(
      'Assigned to Driver can move Out for Delivery or Cancelled — never Hold',
      () {
        expect(
          operatorSelectableStatusTargets('assigned_to_driver'),
          containsAll(['out_for_delivery', 'cancelled']),
        );
        expect(
          operatorSelectableStatusTargets('assigned_to_driver'),
          isNot(contains('hold')),
        );
      },
    );
    test(
      'Out for Delivery exposes Delivered, Returned to Branch, and Cancelled',
      () {
        expect(
          operatorSelectableStatusTargets('out_for_delivery'),
          containsAll(['delivered', 'returned_to_branch', 'cancelled']),
        );
        expect(
          operatorSelectableStatusTargets('out_for_delivery'),
          isNot(contains('hold')),
        );
      },
    );
    test('Returned to Branch can only move to Returned to Trader', () {
      expect(operatorSelectableStatusTargets('returned_to_branch'), [
        'returned_to_trader',
      ]);
    });
    test(
      'Delivered and Returned to Trader are terminal for the Operator (Close is internal)',
      () {
        expect(operatorSelectableStatusTargets('delivered'), isEmpty);
        expect(operatorSelectableStatusTargets('returned_to_trader'), isEmpty);
      },
    );
    test('Cancelled and unknown statuses offer no further action', () {
      expect(operatorSelectableStatusTargets('cancelled'), isEmpty);
      expect(operatorSelectableStatusTargets('some_future_status'), isEmpty);
    });
    test(
      'every offered target is in the approved user-facing status model',
      () {
        for (final status in [
          'new',
          'in_branch',
          'assigned_to_driver',
          'out_for_delivery',
          'hold',
          'delivered',
          'returned_to_branch',
          'returned_to_trader',
          'cancelled',
          'closed',
        ]) {
          for (final target in operatorSelectableStatusTargets(status)) {
            expect(operatorSelectableStatusTargetsAllowlist, contains(target));
          }
        }
      },
    );
  });

  group('reason requirement matches the backend rule (Prompt 12B)', () {
    test(
      'Cancelled, Returned to Branch, and Returned to Trader require a reason',
      () {
        expect(
          operatorStatusChangeReasonRequired,
          containsAll([
            'cancelled',
            'returned_to_branch',
            'returned_to_trader',
          ]),
        );
      },
    );
    test('Delivered and Out for Delivery do not require a reason', () {
      expect(operatorStatusChangeReasonRequired, isNot(contains('delivered')));
      expect(
        operatorStatusChangeReasonRequired,
        isNot(contains('out_for_delivery')),
      );
    });
  });

  group('driver assignment/reassignment eligibility (Prompt 12B)', () {
    test(
      'a fresh assignment is only offered with no Driver and an early status',
      () {
        expect(operatorCanAssignDriver('new', null), isTrue);
        expect(operatorCanAssignDriver('in_branch', null), isTrue);
        expect(operatorCanAssignDriver('hold', null), isTrue);
        expect(operatorCanAssignDriver('out_for_delivery', null), isFalse);
        expect(operatorCanAssignDriver('new', 'driver-1'), isFalse);
      },
    );
    test(
      'reassignment is only offered once a Driver exists and delivery has not started',
      () {
        expect(
          operatorCanReassignDriver('assigned_to_driver', 'driver-1'),
          isTrue,
        );
        expect(operatorCanReassignDriver('hold', 'driver-1'), isTrue);
        expect(
          operatorCanReassignDriver('out_for_delivery', 'driver-1'),
          isFalse,
        );
        expect(operatorCanReassignDriver('delivered', 'driver-1'), isFalse);
        expect(operatorCanReassignDriver('assigned_to_driver', null), isFalse);
      },
    );
    test(
      'assignment and reassignment are always mutually exclusive for one Order',
      () {
        for (final status in [
          'new',
          'in_branch',
          'assigned_to_driver',
          'out_for_delivery',
          'hold',
          'delivered',
          'returned_to_branch',
          'returned_to_trader',
          'cancelled',
          'closed',
        ]) {
          for (final driverId in [null, 'driver-1']) {
            final canAssign = operatorCanAssignDriver(status, driverId);
            final canReassign = operatorCanReassignDriver(status, driverId);
            expect(canAssign && canReassign, isFalse);
          }
        }
      },
    );
  });

  group('OperatorDashboardSummary (Prompt 12B)', () {
    test(
      'statusCount defaults to zero for a status the server did not report',
      () {
        const summary = OperatorDashboardSummary(
          activeTotal: 5,
          byStatus: {'new': 2, 'assigned_to_driver': 3},
          deliveredToday: 1,
          returnPending: 0,
        );
        expect(summary.statusCount('new'), 2);
        expect(summary.statusCount('cancelled'), 0);
      },
    );
  });
}
