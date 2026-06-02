import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { REALTIME_EVENT, REALTIME_NAMESPACE, type RealtimeInvalidate } from '@app/shared';
import type { Env } from '../../config/env.schema';
import { ACCESS_COOKIE_NAME } from '../auth/auth.constants';
import type { AccessTokenPayload } from '../auth/auth.types';

/** Room every platform admin (SUPER_ADMIN / ADMIN_OPERATOR) joins. */
export const ADMIN_ROOM = 'admin';
/** Per-tenant room name. */
export const companyRoom = (companyId: string) => `company:${companyId}`;

/**
 * Socket.IO gateway for realtime cache invalidation. Authenticates the
 * handshake with the same `txn_access` JWT cookie the HTTP API uses, then
 * joins the connection to the rooms it is allowed to hear:
 *   - company users  → `company:<their companyId>`
 *   - platform admins → `admin`
 *
 * It never pushes domain data — only `invalidate` hints telling the client
 * which React Query keys went stale. So even if a socket were spoofed, no
 * tenant data leaks; the data endpoints remain separately authorized.
 */
@WebSocketGateway({ namespace: REALTIME_NAMESPACE })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) return this.reject(client, 'missing access cookie');
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });
      const room = payload.companyId ? companyRoom(payload.companyId) : ADMIN_ROOM;
      await client.join(room);
      this.logger.debug(`Realtime client ${client.id} joined ${room}`);
    } catch {
      // Almost always an expired 15-min access token on reconnect; the web
      // client refreshes and retries. Logged (debug) so a stuck socket is
      // diagnosable instead of failing silently.
      this.reject(client, 'invalid or expired access token');
    }
  }

  /** Emit an invalidate hint to a set of rooms. Never throws. */
  emit(rooms: string[], payload: RealtimeInvalidate): void {
    if (!this.server || rooms.length === 0) return;
    try {
      this.server.to(rooms).emit(REALTIME_EVENT, payload);
    } catch (err) {
      this.logger.warn(`Failed to emit realtime event: ${(err as Error).message}`);
    }
  }

  private reject(client: Socket, reason: string): void {
    this.logger.debug(`Realtime handshake rejected (${reason}); disconnecting ${client.id}`);
    client.disconnect(true);
  }

  private extractToken(client: Socket): string | null {
    const cookieHeader = client.handshake.headers.cookie;
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      if (name === ACCESS_COOKIE_NAME) {
        return decodeURIComponent(part.slice(idx + 1).trim());
      }
    }
    return null;
  }
}
