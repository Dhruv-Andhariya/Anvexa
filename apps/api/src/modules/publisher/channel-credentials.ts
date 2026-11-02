import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { SecretBox } from '../../common/secret-box';

/** A channel's OAuth tokens in plain text. Only lives in memory, never logged or returned by the API. */
export interface ChannelTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  scopes: string;
  connectedBy: string | null;
  /** Provider account of the token (LinkedIn member id + name), when known. */
  accountId?: string | null;
  accountName?: string | null;
}

/** Safe to show HR: no token, just whether the channel is connected and until when. */
export interface ConnectionStatus {
  connected: boolean;
  expiresAt: string | null;
  expired: boolean;
  /** Whose account it is, e.g. the LinkedIn profile name. null for connections made before this was recorded. */
  accountName: string | null;
}

/** Thrown by save() when ENCRYPTION_KEY is missing: we never store a token unencrypted. */
export class EncryptionNotConfiguredError extends Error {
  constructor() {
    super('ENCRYPTION_KEY is not set on the server.');
    this.name = 'EncryptionNotConfiguredError';
  }
}

/** M07 channel_credentials. Every method is scoped by tenantId. Abstract so tests can use an in-memory version. */
export abstract class ChannelCredentials {
  abstract save(tenantId: string, channel: string, tokens: ChannelTokens): Promise<void>;
  abstract remove(tenantId: string, channel: string): Promise<void>;
  /**
   * Access tokens by channel. null = the company HAS a connection for that channel but it cannot be used (expired, or
   * not decryptable): the admin must reconnect, and no server-wide fallback token may be used instead.
   */
  abstract accessTokens(tenantId: string): Promise<Map<string, string | null>>;
  abstract statuses(tenantId: string): Promise<Map<string, ConnectionStatus>>;
}

@Injectable()
export class PrismaChannelCredentials extends ChannelCredentials {
  private readonly logger = new Logger('ChannelCredentials');
  private readonly box = SecretBox.fromEnv();

  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  async save(tenantId: string, channel: string, t: ChannelTokens) {
    if (!this.box) throw new EncryptionNotConfiguredError();
    const data = {
      accessTokenEnc: this.box.encrypt(t.accessToken),
      refreshTokenEnc: t.refreshToken ? this.box.encrypt(t.refreshToken) : null,
      expiresAt: t.expiresAt,
      refreshTokenExpiresAt: t.refreshTokenExpiresAt,
      scopes: t.scopes,
      connectedBy: t.connectedBy,
      accountId: t.accountId ?? null,
      accountName: t.accountName ?? null,
    };
    await this.db.channelCredential.upsert({
      where: { tenantId_channel: { tenantId, channel } },
      create: { tenantId, channel, ...data },
      update: data,
    });
  }

  async remove(tenantId: string, channel: string) {
    await this.db.channelCredential.deleteMany({ where: { tenantId, channel } });
  }

  async accessTokens(tenantId: string) {
    const out = new Map<string, string | null>();
    const rows = await this.db.channelCredential.findMany({ where: { tenantId } });
    for (const r of rows) {
      out.set(r.channel, null);
      if (isExpired(r.expiresAt) || !this.box) continue;
      try {
        out.set(r.channel, this.box.decrypt(r.accessTokenEnc));
      } catch {
        // Wrong / rotated ENCRYPTION_KEY: needs a reconnect (the admin reconnects). Never log the value.
        this.logger.warn(`could not decrypt token channel=${r.channel} tenant=${tenantId}`);
      }
    }
    return out;
  }

  async statuses(tenantId: string) {
    const rows = await this.db.channelCredential.findMany({
      where: { tenantId },
      select: { channel: true, expiresAt: true, accountName: true },
    });
    return new Map(rows.map((r) => [r.channel, statusOf(r.expiresAt, r.accountName)]));
  }
}

export const isExpired = (expiresAt: Date | null, now = Date.now()) => expiresAt !== null && expiresAt.getTime() <= now;

export const statusOf = (expiresAt: Date | null, accountName: string | null = null): ConnectionStatus => ({
  connected: !isExpired(expiresAt),
  expiresAt: expiresAt?.toISOString() ?? null,
  expired: isExpired(expiresAt),
  accountName,
});
