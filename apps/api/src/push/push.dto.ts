import { IsIn, IsOptional, IsString, Length, MaxLength } from "class-validator";

const platforms = ["android", "ios"] as const;

export class RegisterDeviceDto {
  @IsIn(platforms)
  public readonly platform!: (typeof platforms)[number];

  // FCM/APNs tokens are opaque, provider-issued strings with no fixed format
  // guarantee — bounded generously rather than pattern-matched.
  @IsString()
  @Length(16, 4096)
  public readonly token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  public readonly appVersion?: string;
}

export class DeregisterDeviceDto {
  // Optional: omitting it revokes every active registration for the
  // authenticated account (used when a client can no longer read its own
  // current token, e.g. `FirebaseMessaging.instance.deleteToken()` already ran).
  @IsOptional()
  @IsString()
  @Length(16, 4096)
  public readonly token?: string;
}

export class ListNotificationsDto {
  @IsOptional()
  @IsString()
  public readonly cursor?: string;
}
