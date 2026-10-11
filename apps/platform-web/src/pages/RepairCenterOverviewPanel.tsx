import { type ReactElement, useEffect, useState } from "react";

import {
  type RepairCenterOverview,
  platformApi,
  platformApiErrorMessage,
  PlatformApiError,
} from "../api/platform-client.js";

/**
 * Repair Center landing -- consolidated Company health (Phase 2, Prompt 5;
 * Phase 6). High level only: the overall Company health (worst domain), Order
 * Health, Accounting Health, Payroll Health, Repair History counts and the
 * Accounting mode, from one read-only call. Accounting readiness is shown as
 * READY CANDIDATES (preview required); READY is decided only by Preview.
 * Order issues that are accounting findings are labelled as the same root
 * cause Accounting Health lists (not presented as separate work).
 */
export function RepairCenterOverviewPanel({
  companyId,
  refreshToken,
}: {
  readonly companyId: string;
  readonly refreshToken: number;
}): ReactElement {
  const [overview, setOverview] = useState<RepairCenterOverview>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    void platformApi
      .repairCenterOverview(companyId)
      .then((next) => {
        if (!cancelled) setOverview(next);
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(failure instanceof PlatformApiError ? failure.message : platformApiErrorMessage(0, undefined, undefined));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, refreshToken]);

  if (error !== undefined) {
    return (
      <p className="platform-login__error" role="alert">
        {error}
      </p>
    );
  }
  if (overview === undefined) return <p className="platform-muted">Loading Company health…</p>;

  const groups: readonly {
    readonly title: string;
    readonly items: readonly (readonly [string, string | number, string])[];
  }[] = [
    {
      items: [
        ["Healthy", overview.orderHealth.healthy, "ov-orders-healthy"],
        ["Issue", overview.orderHealth.issue, "ov-orders-issue"],
        ["Review", overview.orderHealth.review, "ov-orders-review"],
        ...(overview.orderHealth.accountingRelatedIssues === undefined || overview.orderHealth.accountingRelatedIssues === 0
          ? []
          : ([
              [
                "Of the issues: accounting events (see Accounting Health)",
                overview.orderHealth.accountingRelatedIssues,
                "ov-orders-accounting-related",
              ],
            ] as const)),
      ],
      title: `Order Health · ${overview.orderHealth.companyHealth}`,
    },
    {
      items: [
        ["Failed", overview.accountingHealth.failed, "ov-acc-failed"],
        ["Ready candidates (preview required)", overview.accountingHealth.readyCandidates, "ov-acc-ready"],
        ["Blocked", overview.accountingHealth.blocked, "ov-acc-blocked"],
        ["Manual review", overview.accountingHealth.manualReview, "ov-acc-manual"],
        [
          "Pending / processing",
          `${overview.accountingHealth.pending} / ${overview.accountingHealth.processing}`,
          "ov-acc-pending",
        ],
      ],
      title: `Accounting Health · ${overview.accountingHealth.accountingHealth}`,
    },
    ...(overview.payrollHealth === undefined || overview.payrollHealth === null
      ? []
      : [
          {
            items: [
              ["Payroll periods", overview.payrollHealth.totalPeriods, "ov-payroll-periods"],
              ["Need attention", overview.payrollHealth.periodsWithFindings, "ov-payroll-attention"],
              ["Driver fee findings", overview.payrollHealth.driverFeeFindings, "ov-payroll-driver-fees"],
            ] as const,
            title: `Payroll Health · ${overview.payrollHealth.payrollHealth}`,
          },
        ]),
    {
      items: [
        ["Successful", overview.repairHistory.succeeded, "ov-history-succeeded"],
        ["Failed", overview.repairHistory.failed, "ov-history-failed"],
        ["Refused", overview.repairHistory.refused, "ov-history-refused"],
      ],
      title: "Repair History",
    },
  ];

  return (
    <section aria-label="Company health overview" className="platform-card">
      <p className="platform-muted">
        {overview.company.nameEn} ({overview.company.code}) · Accounting Mode{" "}
        <strong data-testid="ov-accounting-mode">{overview.accountingMode.enabled ? "ON" : "OFF"}</strong>
        {overview.companyHealth === undefined ? null : (
          <>
            {" "}
            · Company Health <strong data-testid="ov-company-health">{overview.companyHealth}</strong>
          </>
        )}
      </p>
      {groups.map((group) => (
        <div key={group.title}>
          <h3>{group.title}</h3>
          <div aria-label={group.title} className="platform-summary-strip">
            {group.items.map(([label, value, testId]) => (
              <div className="platform-summary-card platform-summary-card--info" key={testId}>
                <span className="platform-summary-card__label">{label}</span>
                <span className="platform-summary-card__value" data-testid={testId}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <p className="platform-muted" data-testid="ov-ready-note">
        {overview.accountingHealth.readyCandidateNote}
      </p>
    </section>
  );
}
