export type LiveAvatarAdmission = {
  activeSessions: number;
  maxConcurrentSessions: number;
  recentIpStarts: number;
  startRateLimitPerMinute: number;
  usedSecondsToday: number;
  dailyMinuteCap: number | null;
};

export type LiveAvatarAdmissionFailure =
  | "live_avatar_session_limit_reached"
  | "live_avatar_rate_limit_reached"
  | "live_avatar_daily_cap_reached";

export function liveAvatarAdmissionFailure(input: LiveAvatarAdmission): LiveAvatarAdmissionFailure | null {
  if (input.activeSessions >= input.maxConcurrentSessions) return "live_avatar_session_limit_reached";
  if (input.recentIpStarts >= input.startRateLimitPerMinute) return "live_avatar_rate_limit_reached";
  if (input.dailyMinuteCap !== null && input.usedSecondsToday >= input.dailyMinuteCap * 60)
    return "live_avatar_daily_cap_reached";
  return null;
}
