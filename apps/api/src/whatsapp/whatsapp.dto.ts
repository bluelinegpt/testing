import { IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength } from "class-validator";

export const whatsappMessageLanguages = ["both", "ar", "en"] as const;
export type WhatsAppMessageLanguage = (typeof whatsappMessageLanguages)[number];

export const whatsappDestinationTypes = ["group"] as const;
export type WhatsAppDestinationType = (typeof whatsappDestinationTypes)[number];

export class UpdateTraderWhatsAppSettingsDto {
  @IsBoolean()
  public readonly notificationsEnabled!: boolean;

  // Only `group` exists today; the closed @IsIn (and the matching database
  // CHECK) is what a later prompt widens when new destination types are
  // approved.
  @IsOptional()
  @IsIn(whatsappDestinationTypes)
  public readonly destinationType?: WhatsAppDestinationType;

  // The provider's internal chat id (e.g. `1203...@g.us`) — opaque and
  // provider-issued, so bounded generously rather than pattern-matched.
  @IsOptional()
  @IsString()
  @Length(1, 256)
  public readonly providerGroupId?: string;

  // Display/audit snapshot only — never used as the group's identity.
  @IsOptional()
  @IsString()
  @MaxLength(512)
  public readonly groupNameSnapshot?: string;

  @IsOptional()
  @IsIn(whatsappMessageLanguages)
  public readonly messageLanguage?: WhatsAppMessageLanguage;
}

/**
 * The public connection view. Deliberately EXCLUDES
 * `encrypted_session_state` and `provider_account_reference` — session and
 * provider account material is credential-grade and never leaves the backend
 * through any API response.
 *
 * `qr` is the ONLY pairing artifact that ever reaches the frontend: the
 * current QR payload string, present exclusively while the status is
 * `waiting_for_qr_scan`, tenant-scoped, held in server memory only, and
 * rotating on the provider's own schedule (the frontend just re-polls this
 * endpoint and re-renders). It must never be written to browser storage.
 */
export interface CompanyWhatsAppConnectionView {
  readonly status: string;
  readonly providerType: string;
  readonly connectedPhoneNumber: string | null;
  readonly connectedAt: Date | null;
  readonly lastConnectedAt: Date | null;
  readonly lastDisconnectedAt: Date | null;
  readonly disconnectReason: string | null;
  readonly lastHealthCheckAt: Date | null;
  readonly requiresQrScan: boolean;
  readonly qrAvailable: boolean;
  readonly qr: string | null;
}

export interface WhatsAppGroupView {
  /** The provider's internal group id (e.g. `1203...@g.us`) — the group's
   *  authoritative identity. The name is display data only. */
  readonly id: string;
  readonly name: string;
  readonly participantCount?: number;
}

export interface TraderWhatsAppSettingsView {
  readonly traderId: string;
  readonly configured: boolean;
  readonly notificationsEnabled: boolean;
  readonly destinationType: WhatsAppDestinationType;
  readonly providerGroupId: string | null;
  readonly groupNameSnapshot: string | null;
  readonly messageLanguage: WhatsAppMessageLanguage;
  readonly configuredAt: Date | null;
}

export interface WhatsAppNotificationView {
  readonly id: string;
  readonly traderId: string;
  readonly orderId: string;
  readonly orderStatusHistoryId: string;
  readonly destinationType: string;
  readonly providerGroupId: string;
  readonly groupNameSnapshot: string | null;
  readonly messageLanguage: string;
  readonly messageBody: string;
  readonly status: string;
  readonly providerMessageId: string | null;
  readonly queuedAt: Date;
  readonly sentAt: Date | null;
  readonly failedAt: Date | null;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  readonly attemptCount: number;
  readonly createdAt: Date;
}
