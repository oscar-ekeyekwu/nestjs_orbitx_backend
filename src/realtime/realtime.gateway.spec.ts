/* eslint-disable @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-assignment --
 * Setting the WebSocketServer + userSockets Map on the gateway from
 * a unit test requires `any` casts; the typed surface is private and
 * the integration test path uses the real Server. */
import { RealtimeGateway } from './realtime.gateway';

describe('RealtimeGateway (ARCH-12 room semantics)', () => {
  it('builds the eligible-room name with the documented shape', () => {
    expect(RealtimeGateway.eligibleRoom('small')).toBe(
      'drivers:eligible:lagos:small',
    );
    expect(RealtimeGateway.eligibleRoom('large')).toBe(
      'drivers:eligible:lagos:large',
    );
  });

  describe('joinDriverToEligibleRooms', () => {
    function makeGateway(connected: boolean): {
      gateway: RealtimeGateway;
      socket: { join: jest.Mock; leave: jest.Mock; rooms: Set<string> };
    } {
      const socket = {
        join: jest.fn(),
        leave: jest.fn(),
        rooms: new Set<string>(),
      };
      const server = {
        sockets: {
          sockets: new Map<string, typeof socket>(),
        },
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        emit: jest.fn(),
      };
      if (connected) {
        server.sockets.sockets.set('sock-1', socket);
      }
      const gateway = new RealtimeGateway(
        null as never,
        null as never,
        null as never,
      );

      (gateway as any).server = server;

      const userMap: Map<string, string> = (gateway as any).userSockets;
      userMap.set('user-1', 'sock-1');
      return { gateway, socket };
    }

    it('joins the supplied rooms when the driver socket is connected', () => {
      const { gateway, socket } = makeGateway(true);
      const joined = gateway.joinDriverToEligibleRooms('user-1', [
        'small',
        'medium',
      ]);
      expect(joined).toEqual([
        'drivers:eligible:lagos:small',
        'drivers:eligible:lagos:medium',
      ]);
      expect(socket.join).toHaveBeenCalledWith('drivers:eligible:lagos:small');
      expect(socket.join).toHaveBeenCalledWith('drivers:eligible:lagos:medium');
    });

    it('returns [] silently when no socket is connected for the user', () => {
      const { gateway, socket } = makeGateway(false);
      const joined = gateway.joinDriverToEligibleRooms('user-2', ['small']);
      expect(joined).toEqual([]);
      expect(socket.join).not.toHaveBeenCalled();
    });
  });

  describe('leaveDriverFromEligibleRooms', () => {
    it('leaves every drivers:eligible:lagos:* room currently subscribed', () => {
      const socket = {
        join: jest.fn(),
        leave: jest.fn(),
        rooms: new Set<string>([
          'user:u-1',
          'drivers:eligible:lagos:small',
          'drivers:eligible:lagos:medium',
          'order:o-1',
        ]),
      };
      const server = {
        sockets: { sockets: new Map([['sock-1', socket]]) },
        to: jest.fn(),
        emit: jest.fn(),
      };
      const gateway = new RealtimeGateway(
        null as never,
        null as never,
        null as never,
      );

      (gateway as any).server = server;

      ((gateway as any).userSockets as Map<string, string>).set(
        'user-1',
        'sock-1',
      );

      const left = gateway.leaveDriverFromEligibleRooms('user-1');

      expect(left).toEqual([
        'drivers:eligible:lagos:small',
        'drivers:eligible:lagos:medium',
      ]);
      expect(socket.leave).toHaveBeenCalledWith('drivers:eligible:lagos:small');
      expect(socket.leave).toHaveBeenCalledWith(
        'drivers:eligible:lagos:medium',
      );
      // Non-eligible rooms are NEVER touched — they belong to other
      // subscriptions (per-user, per-order) and have their own lifecycle.
      expect(socket.leave).not.toHaveBeenCalledWith('user:u-1');
      expect(socket.leave).not.toHaveBeenCalledWith('order:o-1');
    });
  });

  describe('emitOrderOffered / emitOrderTaken', () => {
    it('emits order_offered to the room keyed by packageSize', () => {
      const emit = jest.fn();
      const to = jest.fn().mockReturnValue({ emit });
      const server = { to, emit: jest.fn(), sockets: { sockets: new Map() } };
      const gateway = new RealtimeGateway(
        null as never,
        null as never,
        null as never,
      );

      (gateway as any).server = server;

      const room = gateway.emitOrderOffered('medium', { id: 'o-1' });

      expect(room).toBe('drivers:eligible:lagos:medium');
      expect(to).toHaveBeenCalledWith('drivers:eligible:lagos:medium');
      expect(emit).toHaveBeenCalledWith(
        'order_offered',
        expect.objectContaining({ order: { id: 'o-1' } }),
      );
    });

    it('emits order_taken to the same room with the orderId', () => {
      const emit = jest.fn();
      const to = jest.fn().mockReturnValue({ emit });
      const server = { to, emit: jest.fn(), sockets: { sockets: new Map() } };
      const gateway = new RealtimeGateway(
        null as never,
        null as never,
        null as never,
      );

      (gateway as any).server = server;

      const room = gateway.emitOrderTaken('large', 'o-99');

      expect(room).toBe('drivers:eligible:lagos:large');
      expect(emit).toHaveBeenCalledWith(
        'order_taken',
        expect.objectContaining({ orderId: 'o-99' }),
      );
    });
  });
});
