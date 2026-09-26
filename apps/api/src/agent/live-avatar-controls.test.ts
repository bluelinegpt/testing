import { describe, expect, it } from "vitest";
import { liveAvatarAdmissionFailure } from "./live-avatar-controls.js";

const allowed = {
  activeSessions: 0,
  maxConcurrentSessions: 2,
  recentIpStarts: 0,
  startRateLimitPerMinute: 3,
  usedSecondsToday: 0,
  dailyMinuteCap: 60,
};

describe("live avatar cost controls", () => {
  it("allows a session below every configured cap", () => {
    expect(liveAvatarAdmissionFailure(allowed)).toBeNull();
  });

  it("blocks the concurrency cap", () => {
    expect(liveAvatarAdmissionFailure({ ...allowed, activeSessions: 2 })).toBe("live_avatar_session_limit_reached");
  });

  it("blocks the per-IP start rate", () => {
    expect(liveAvatarAdmissionFailure({ ...allowed, recentIpStarts: 3 })).toBe("live_avatar_rate_limit_reached");
  });

  it("blocks the daily minute cap", () => {
    expect(liveAvatarAdmissionFailure({ ...allowed, usedSecondsToday: 3600 })).toBe("live_avatar_daily_cap_reached");
  });

  it("supports an unlimited daily cap", () => {
    expect(liveAvatarAdmissionFailure({ ...allowed, usedSecondsToday: 999999, dailyMinuteCap: null })).toBeNull();
  });
});
