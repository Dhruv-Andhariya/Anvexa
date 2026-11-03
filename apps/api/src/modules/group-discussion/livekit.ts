import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';

/**
 * Everything the GD module asks of LiveKit (LiveKit Cloud's free plan, or any LiveKit server): join tokens, rooms,
 * the room metadata that carries the live state to every screen and to the moderator bot, HR becoming visible when
 * speaking, and dispatching the bot. Abstract so tests run without LiveKit.
 */
export abstract class LiveKitGateway {
  /** null = LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set. */
  abstract readonly url: string | null;
  abstract token(input: { room: string; identity: string; name: string; hidden?: boolean; canPublish?: boolean; ttlSeconds: number; metadata?: string }): Promise<string>;
  abstract createRoom(room: string, metadata: string, maxParticipants: number): Promise<void>;
  abstract setRoomMetadata(room: string, metadata: string): Promise<void>;
  /** Shows or hides a participant (HR) for everyone else in the room. */
  abstract setHidden(room: string, identity: string, hidden: boolean): Promise<void>;
  abstract dispatchModerator(room: string, metadata: string): Promise<void>;
  abstract removeParticipant(room: string, identity: string): Promise<void>;
}

export class LiveKitNotConfigured extends Error {
  constructor() {
    super('LiveKit is not set up (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)');
    this.name = 'LiveKitNotConfigured';
  }
}

/** The bot's agent name (workers/gd-agent registers with the same name). */
export const MODERATOR_AGENT = 'gd-moderator';

export class LiveKitCloudGateway extends LiveKitGateway {
  readonly url: string | null;
  private readonly rooms: RoomServiceClient | null;
  private readonly agents: AgentDispatchClient | null;

  constructor(private readonly env: { url: string; key: string; secret: string } | null) {
    super();
    this.url = env?.url ?? null;
    const host = env ? env.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:') : '';
    this.rooms = env ? new RoomServiceClient(host, env.key, env.secret) : null;
    this.agents = env ? new AgentDispatchClient(host, env.key, env.secret) : null;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LiveKitCloudGateway {
    const url = (env.LIVEKIT_URL ?? '').trim();
    const key = (env.LIVEKIT_API_KEY ?? '').trim();
    const secret = (env.LIVEKIT_API_SECRET ?? '').trim();
    return new LiveKitCloudGateway(url && key && secret ? { url, key, secret } : null);
  }

  async token(i: { room: string; identity: string; name: string; hidden?: boolean; canPublish?: boolean; ttlSeconds: number; metadata?: string }) {
    if (!this.env) throw new LiveKitNotConfigured();
    const at = new AccessToken(this.env.key, this.env.secret, { identity: i.identity, name: i.name, ttl: i.ttlSeconds, metadata: i.metadata });
    at.addGrant({
      room: i.room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: i.canPublish ?? true,
      canPublishData: true,
      hidden: i.hidden ?? false,
      // students cannot change their own name / metadata
      canUpdateOwnMetadata: false,
    });
    return at.toJwt();
  }

  async createRoom(room: string, metadata: string, maxParticipants: number) {
    // keeps the room for a while when everyone drops (reconnects)
    await this.client().createRoom({ name: room, metadata, maxParticipants, emptyTimeout: 30 * 60, departureTimeout: 10 * 60 });
  }

  async setRoomMetadata(room: string, metadata: string) {
    await this.client().updateRoomMetadata(room, metadata);
  }

  async setHidden(room: string, identity: string, hidden: boolean) {
    await this.client().updateParticipant(room, identity, { permission: { hidden, canPublish: true, canSubscribe: true, canPublishData: true } });
  }

  async dispatchModerator(room: string, metadata: string) {
    if (!this.agents) throw new LiveKitNotConfigured();
    await this.agents.createDispatch(room, MODERATOR_AGENT, { metadata });
  }

  async removeParticipant(room: string, identity: string) {
    await this.client().removeParticipant(room, identity);
  }

  private client(): RoomServiceClient {
    if (!this.rooms) throw new LiveKitNotConfigured();
    return this.rooms;
  }
}
