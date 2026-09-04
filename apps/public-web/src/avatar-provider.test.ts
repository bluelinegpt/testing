import { describe, expect, it, vi } from "vitest";
import { createAvatarProvider, transcriptTrackUrl } from "./avatar-provider";

describe("avatar provider boundary", () => {
  it("plays prerecorded media without requesting visitor devices", async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn();
    const video = { play, pause } as unknown as HTMLVideoElement;
    const provider = createAvatarProvider("prerecorded", video);

    await expect(provider.initializeSession()).resolves.toEqual({ status: "ok" });
    await expect(provider.playIntro()).resolves.toEqual({ status: "ok" });
    await expect(provider.startListening()).resolves.toEqual({ status: "not_supported" });
    await expect(provider.speakResponse("private customer text")).resolves.toEqual({ status: "not_supported" });
    await expect(provider.endSession()).resolves.toEqual({ status: "ok" });
    expect(play).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
  });

  it("fails future providers safely and produces a captions track", async () => {
    const provider = createAvatarProvider("heygen", null);
    await expect(provider.initializeSession()).resolves.toEqual({ status: "not_supported" });
    expect(decodeURIComponent(transcriptTrackUrl("Welcome --> safely"))).toContain("Welcome → safely");
  });
});
