import { ApiError, type ApiClient } from "../../api/api-client.js";

/**
 * Posting a settlement draft safely when the server is slow (SET-PERF-1,
 * 16 Nov 2026).
 *
 * WHAT WENT WRONG: the browser gave up after 10 s and said "Please try again",
 * but the server finished and committed about 20 s later. People clicked again
 * and one settlement was re-created.
 *
 * WHAT THIS DOES:
 *   1. posts with a 90 s limit instead of 10 s;
 *   2. when the answer is lost (timeout, dropped connection, gateway error) it
 *      never says "try again" -- it reloads the draft and reports what really
 *      happened;
 *   3. if the draft turns out to be posted, it asks the server for that post's
 *      result. The confirm endpoint is idempotent per draft: on a posted draft
 *      it returns what the first post created and never creates a second one.
 */

export type ConfirmOutcome<TResult> =
  | { readonly outcome: "posted"; readonly result: TResult }
  | { readonly outcome: "not_posted" }
  | { readonly outcome: "unknown" };

interface DraftStatus {
  readonly status: string;
}

/** True when we cannot know whether the server did the work. */
export function isUncertainOutcome(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.code === "request_timeout" || [502, 503, 504].includes(error.status);
  }
  // fetch() rejects with a TypeError when the connection drops.
  return error instanceof TypeError;
}

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

export async function confirmDraftSafely<TResult>(
  api: Pick<ApiClient, "get" | "postLong">,
  draftId: string,
  onChecking: () => void,
  options: {
    readonly attempts?: number;
    readonly intervalMs?: number;
    readonly wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<ConfirmOutcome<TResult>> {
  const path = `operations/settlements/drafts/${draftId}/confirm`;
  try {
    return { outcome: "posted", result: await api.postLong<TResult>(path) };
  } catch (error) {
    if (!isUncertainOutcome(error)) throw error;
  }
  onChecking();
  const attempts = options.attempts ?? 8;
  const intervalMs = options.intervalMs ?? 5_000;
  const wait = options.wait ?? defaultWait;
  let reached = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(intervalMs);
    let draft: DraftStatus;
    try {
      draft = await api.get<DraftStatus>(`operations/settlements/drafts/${draftId}`);
    } catch (error) {
      if (!isUncertainOutcome(error)) throw error;
      continue;
    }
    reached = true;
    if (draft.status === "confirmed") {
      // Idempotent: returns the existing post, never a second settlement.
      return { outcome: "posted", result: await api.postLong<TResult>(path) };
    }
    // Still a draft: the first request may still be running on the server
    // (it holds the draft row until it commits), so look again before
    // concluding it was not posted.
  }
  return reached ? { outcome: "not_posted" } : { outcome: "unknown" };
}
