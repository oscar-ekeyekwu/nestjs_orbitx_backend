import { BadRequestException } from '@nestjs/common';
import { StateMachine, Transition } from './transitions';

type Sample = 'a' | 'b' | 'c';

describe('StateMachine<S> (ARCH-3 helper)', () => {
  const transitions: ReadonlyArray<Transition<Sample>> = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c', requiredRole: 'admin' },
    { from: 'c', to: 'a', requiredRole: 'system' },
  ];
  const sm = new StateMachine<Sample>(transitions);

  describe('canTransition', () => {
    it('returns true for declared edges', () => {
      expect(sm.canTransition('a', 'b')).toBe(true);
      expect(sm.canTransition('b', 'c')).toBe(true);
      expect(sm.canTransition('c', 'a')).toBe(true);
    });

    it('returns false for undeclared edges, self-loops, and unknown states', () => {
      expect(sm.canTransition('a', 'c')).toBe(false);
      expect(sm.canTransition('a', 'a')).toBe(false);
      expect(sm.canTransition('c', 'b')).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('returns silently on a legal transition', () => {
      expect(() => sm.assertTransition('a', 'b', 'TEST_001')).not.toThrow();
    });

    it('throws BadRequestException with the supplied error code', () => {
      let caught: unknown;
      try {
        sm.assertTransition('a', 'c', 'TEST_001');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      const response = (caught as BadRequestException).getResponse() as {
        errorCode: string;
        message: string;
      };
      expect(response.errorCode).toBe('TEST_001');
      expect(response.message).toContain('a');
      expect(response.message).toContain('c');
    });
  });

  describe('getTransition / metadata', () => {
    it('returns the matching Transition for a declared edge', () => {
      const t = sm.getTransition('b', 'c');
      expect(t).toEqual({ from: 'b', to: 'c', requiredRole: 'admin' });
    });

    it('returns undefined for an unknown edge', () => {
      expect(sm.getTransition('a', 'c')).toBeUndefined();
    });
  });

  describe('nextStates', () => {
    it('lists the legal next states from a given state', () => {
      expect(sm.nextStates('a')).toEqual(['b']);
    });

    it('returns an empty list for a state with no outgoing edges', () => {
      const dead = new StateMachine<Sample>([{ from: 'a', to: 'b' }]);
      expect(dead.nextStates('c')).toEqual([]);
    });
  });
});
