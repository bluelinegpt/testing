# Cash Movement Audit Trail - Testing Plan

## Overview
This document outlines testing strategy for the 4-phase cash movement auto-generation implementation across all payment types.

---

## Phase 1: General Expense Payments

### Test Scenario 1.1: Cash Expense Payment
**Setup:**
- Create General Expense (EXP-000001): AED 500
- Approve expense
- Pay with Cash (from Main Cash account)

**Expected Results:**
- ✅ Accounting Entry: Debit Payable, Credit Cash GL
- ✅ Movement Created: CBM-XXXXX (cash_withdrawal, AED 500)
- ✅ Movement Status: confirmed
- ✅ GL Event: Posted (cash_withdrawal_confirmed)

**Success Criteria:**
- Movement amount matches payment amount exactly
- Source cash account is correctly recorded
- No GL discrepancy between entry and movement

### Test Scenario 1.2: Bank Expense Payment
**Setup:**
- Create General Expense (EXP-000002): AED 1,000
- Approve expense
- Pay with Bank Transfer (from Company Bank)

**Expected Results:**
- ✅ Accounting Entry: Debit Payable, Credit Bank GL
- ✅ Movement Created: CBM-XXXXX (bank_withdrawal, AED 1,000)
- ✅ Bank Account correctly recorded
- ✅ GL Event: Posted

**Success Criteria:**
- Bank account linked correctly
- Movement references payment number

---

## Phase 2A: Driver Collections

### Test Scenario 2A.1: Cash Collection from Driver
**Setup:**
- Driver collects AED 5,000 from customers
- Driver submits collection (Driver Reconciliation)
- Mark as cash received

**Expected Results:**
- ✅ Accounting Entry: Debit Cash, Credit Receivable
- ✅ Movement Created: CBM-XXXXX (cash_deposit, AED 5,000)
- ✅ Cash Account recorded
- ✅ Status: confirmed

**Success Criteria:**
- Deposit movement (not withdrawal)
- Cash account source is captured
- Reconciliation number in metadata

### Test Scenario 2A.2: Bank Transfer Collection
**Setup:**
- Driver submits collection as bank transfer
- Amount: AED 3,000

**Expected Results:**
- ✅ Movement: CBM-XXXXX (bank_deposit, AED 3,000)
- ✅ Bank account linked
- ✅ GL posted

**Success Criteria:**
- Correct movement type
- Bank account referenced

---

## Phase 2B: Trader Settlements

### Test Scenario 2B.1: Cash Payment to Trader
**Setup:**
- Trader payable: AED 10,000
- Settle with Cash

**Expected Results:**
- ✅ Accounting Entry: Debit Payable, Credit Cash
- ✅ Movement: CBM-XXXXX (cash_withdrawal, AED 10,000)
- ✅ Cash account recorded
- ✅ Settlement number in metadata

**Success Criteria:**
- Movement amount matches settlement
- Source account is recorded
- Can trace from settlement → movement → GL

### Test Scenario 2B.2: Bank Payment to Trader
**Setup:**
- Trader payable: AED 7,500
- Settle with Bank Transfer

**Expected Results:**
- ✅ Movement: CBM-XXXXX (bank_withdrawal, AED 7,500)
- ✅ Bank account linked
- ✅ GL entry matches movement

**Success Criteria:**
- Correct bank account
- Movement status confirmed

---

## Phase 3A: Payroll Payments

### Test Scenario 3A.1: Payroll Cash Payment
**Setup:**
- Payroll period: 100 employees
- Total amount: AED 50,000
- Payment method: Cash

**Expected Results:**
- ✅ Accounting Entry: Debit Payable, Credit Cash
- ✅ Movement: CBM-XXXXX (cash_withdrawal, AED 50,000)
- ✅ Cash account recorded
- ✅ Single movement per payment (not per employee)

**Success Criteria:**
- Movement equals total payroll
- Created immediately after payment confirmation
- GL balance matches movement

---

## Phase 3B: Driver Fee Payments

### Test Scenario 3B.1: Driver Fee Cash Payment
**Setup:**
- Driver fee accrual: AED 2,500
- Pay with Cash

**Expected Results:**
- ✅ Movement: CBM-XXXXX (cash_withdrawal, AED 2,500)
- ✅ Cash account recorded
- ✅ Payment number referenced

**Success Criteria:**
- Movement status: confirmed
- GL posting event created
- Correct payment amount

### Test Scenario 3B.2: Collection Offset (should NOT create movement)
**Setup:**
- Driver fee via collection offset (automatic deduction)

**Expected Results:**
- ✅ NO movement created (collection_offset is not a cash/bank transaction)
- ✅ Accounting entry only

**Success Criteria:**
- Movement creation skipped for collection_offset
- System handles gracefully

---

## Phase 4A: Employee Salary Advances

### Test Scenario 4A.1: Salary Advance (Cash)
**Setup:**
- Employee advance: AED 5,000
- Payment method: Cash

**Expected Results:**
- ✅ Accounting Entry: Debit Advance Clearing, Credit Cash
- ✅ Movement: CBM-XXXXX (cash_withdrawal, AED 5,000)
- ✅ Cash account recorded
- ✅ Advance number in metadata

**Success Criteria:**
- Movement created immediately
- Status: confirmed
- GL entry matches

### Test Scenario 4A.2: Salary Advance (Bank)
**Setup:**
- Employee advance: AED 3,000
- Payment method: Bank

**Expected Results:**
- ✅ Movement: CBM-XXXXX (bank_withdrawal, AED 3,000)
- ✅ Bank account linked
- ✅ GL posted

**Success Criteria:**
- Correct movement type
- Bank account correct

---

## Phase 4B: Variable Earnings Interim Payments

### Test Scenario 4B.1: Interim Variable Earnings (Cash)
**Setup:**
- Employee interim payment: AED 2,000
- Payment method: Cash
- Payment number: VAR-000001

**Expected Results:**
- ✅ Movement: CBM-XXXXX (cash_withdrawal, AED 2,000)
- ✅ Cash account recorded
- ✅ Payment number in metadata

**Success Criteria:**
- Movement created for interim payment
- Amount matches requested
- GL entry synced

### Test Scenario 4B.2: Interim Earnings (Bank)
**Setup:**
- Interim payment: AED 1,500
- Payment method: Bank

**Expected Results:**
- ✅ Movement: CBM-XXXXX (bank_withdrawal, AED 1,500)
- ✅ Bank account linked

**Success Criteria:**
- Correct movement type
- Confirmed status

---

## Cross-Phase Test Scenarios

### Test C.1: Multiple Payments Same Day
**Setup:**
- 3 different payment types same day (expense, payroll, trader)
- Total: AED 25,000

**Expected Results:**
- ✅ 3 separate movements created (CBM-XXXXX, CBM-XXXXY, CBM-XXXYZ)
- ✅ Each movement is sequential number
- ✅ All status: confirmed

**Success Criteria:**
- Movement numbers don't conflict
- Each tracked independently
- GL entries all balanced

### Test C.2: Split Payments
**Setup:**
- Single expense paid with 2 methods:
  - Cash: AED 300
  - Bank: AED 200

**Expected Results:**
- ✅ 2 movements created:
  - CBM-XXXXX (cash_withdrawal, AED 300)
  - CBM-XXXXY (bank_withdrawal, AED 200)
- ✅ Each linked to correct account
- ✅ Total = AED 500

**Success Criteria:**
- Split payments create multiple movements
- Each tracked separately
- GL entry matches total

### Test C.3: Movement-GL Reconciliation
**Setup:**
- Run after 24 hours of mixed payments

**Expected Results:**
- ✅ Sum of cash movements = Cash GL credit total
- ✅ Sum of bank movements = Bank GL credit total
- ✅ No orphaned movements
- ✅ No movements without GL entries

**Success Criteria:**
- Perfect reconciliation
- Audit trail complete
- No data gaps

---

## Data Validation Tests

### Test D.1: Movement Number Uniqueness
**Verification:**
- Check all CBM movement numbers are unique
- Check no duplicates across all phases
- Verify sequential increment

**Expected:**
- Each movement has unique CBM-XXXXXX
- No collisions

### Test D.2: Account Linking
**Verification:**
- Verify `company_cash_account_id` populated for cash movements
- Verify `company_bank_account_id` populated for bank movements
- Verify GL links are correct

**Expected:**
- 100% account population
- Correct account type for payment method

### Test D.3: GL Event Creation
**Verification:**
- Every movement has corresponding accounting_event
- Event type matches movement type
- GL posting occurred

**Expected:**
- 1:1 mapping of movements to events
- All events in 'posted' state

### Test D.4: Timestamp Accuracy
**Verification:**
- Movement `confirmed_at` = actual confirmation time
- GL event `created_at` = movement creation time
- No future dates

**Expected:**
- Timestamps sequential
- Accurate to seconds

---

## Performance Tests

### Test P.1: High Volume Payment Confirmation
**Setup:**
- Process 100 payments in rapid succession
- Mix of all payment types
- Measure movement creation time

**Expected:**
- Movement creation < 100ms per payment
- No timeouts
- No database lock issues

### Test P.2: Large Amount Handling
**Setup:**
- Payment: AED 1,000,000
- Split across multiple movement rows if needed

**Expected:**
- Movement created correctly
- Decimal precision maintained
- No overflow errors

---

## Error Handling Tests

### Test E.1: Missing Funding Account
**Setup:**
- Payment without cash/bank account specified
- Should be caught at payment confirmation

**Expected:**
- Payment rejected (existing validation)
- No movement created
- Clear error message

### Test E.2: Inactive Account
**Setup:**
- Payment to inactive cash account
- Should be caught at payment confirmation

**Expected:**
- Payment rejected
- No movement created

### Test E.3: Duplicate Idempotency
**Setup:**
- Retry same payment with same idempotency key
- Should return same response

**Expected:**
- Movement created only once
- Replay returns same movement ID
- No duplicates

---

## Audit Trail Tests

### Test A.1: Complete Trace - Expense to Cash
**Trace:**
1. Create Expense (EXP-000001)
2. Approve Expense
3. Pay with Cash (AED 500)
4. Verify movement created
5. Verify GL entry
6. Verify cash account balance changed

**Expected:**
- Each step traceable
- Movement links to payment
- Payment links to expense
- GL updated immediately

### Test A.2: Complete Trace - Driver Collection to Main Cash
**Trace:**
1. Driver reconciliation (REC-000001)
2. Cash collection AED 5,000
3. Mark confirmed
4. Verify movement created
5. Verify GL entry
6. Verify cash account balance increased

**Expected:**
- Collection → Movement → GL all linked
- Balance reflects collection

---

## Rollback Tests

### Test R.1: Payment Reversal - Movement Also Reversed
**Setup:**
- Confirmed payment with movement
- Reverse the payment

**Expected:**
- Payment status: reversed
- Original movement remains (audit trail)
- Reversal creates offsetting movement?
- GL entries balanced

**Success Criteria:**
- Clear audit trail of reversal
- GL still reconciles

---

## Test Execution Plan

### Phase 1: Unit/Integration Tests (Local)
- Run all scenarios 1.1-4B.2 in test environment
- Verify database state
- Check GL entries

### Phase 2: End-to-End Tests (Staging)
- Run cross-phase tests (C.1-C.3)
- Verify production-like load
- Check performance

### Phase 3: Data Validation (Production-like)
- Run data validation tests (D.1-D.4)
- Verify audit trail completeness
- Check no data gaps

### Phase 4: Production Verification (After Deploy)
- Run audit trail tests (A.1-A.2)
- Spot-check sample transactions
- Monitor for errors in Error Handler

---

## Success Criteria Summary

✅ **All payment types create movements automatically**
✅ **Movement status: confirmed immediately**
✅ **GL entries created for each movement**
✅ **No data loss or orphaned records**
✅ **Audit trail complete end-to-end**
✅ **Accounts properly linked**
✅ **Timestamps accurate**
✅ **Performance acceptable**
✅ **Error handling graceful**
✅ **Idempotency working**

---

## Known Limitations

- Collection offset (driver fees) does NOT create movement (by design - no cash/bank movement)
- Movements created only for confirmed payments (no drafts)
- Reversal handling still to be verified

---

## Next Steps

1. ✅ Phase 1-4 Implementation Complete
2. ⏳ Execute Testing Plan
3. ⏳ Fix any issues found
4. ⏳ Prepare for deployment
5. ⏳ Monitor in production
