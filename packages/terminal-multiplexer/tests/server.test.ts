import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTerminalMultiplexer } from '../index';

const spawned = vi.hoisted(() => [] as FakePty[]);

type FakePty = {
  emitData(data: string): void;
  emitExit(exitCode: number): void;
  kill: ReturnType<typeof vi.fn>;
  onData(handler: (data: string) => void): void;
  onExit(handler: (event: { exitCode: number }) => void): void;
  resize: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    let dataHandler: (data: string) => void = () => undefined;
    let exitHandler: (event: { exitCode: number }) => void = () => undefined;
    const terminal: FakePty = {
      emitData(data) {
        dataHandler(data);
      },
      emitExit(exitCode) {
        exitHandler({ exitCode });
      },
      kill: vi.fn(),
      onData(handler) {
        dataHandler = handler;
      },
      onExit(handler) {
        exitHandler = handler;
      },
      resize: vi.fn(),
      write: vi.fn(),
    };
    spawned.push(terminal);
    return terminal;
  }),
}));

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  bufferedAmount = 0;
  readyState = this.OPEN;
  readonly send = vi.fn();

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

describe('SessionTerminalMultiplexer', () => {
  beforeEach(() => {
    spawned.length = 0;
    vi.clearAllMocks();
  });

  it('isolates agent sessions and keeps PTYs alive when their viewer closes', () => {
    const multiplexer = new SessionTerminalMultiplexer();
    const first = multiplexer.create('session-a', '/tmp/a');
    const second = multiplexer.create('session-b', '/tmp/b');
    const viewer = new FakeSocket();

    expect(multiplexer.list('session-a')).toEqual([first]);
    expect(multiplexer.list('session-b')).toEqual([second]);
    expect(multiplexer.attach('session-a', first.id, viewer as never)).toBe(true);

    viewer.close();
    spawned[0]?.emitData('still running');

    expect(viewer.send).not.toHaveBeenCalled();
    expect(spawned[0]?.kill).not.toHaveBeenCalled();
    expect(multiplexer.list('session-a')).toEqual([first]);

    expect(multiplexer.closeTerminal('session-a', first.id)).toBe(true);
    expect(spawned[0]?.kill).toHaveBeenCalledOnce();
    expect(spawned[1]?.kill).not.toHaveBeenCalled();
    expect(multiplexer.list('session-b')).toEqual([second]);

    multiplexer.close();
    expect(spawned[1]?.kill).toHaveBeenCalledOnce();
  });
});
