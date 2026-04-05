import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initWorkflow } from '../src/workflow-singleton';
import type { WorkflowSingletonOptions } from '../src/workflow-singleton';

describe('Workflow Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should accept createMessagePoster factory in options', () => {
    const mockCreateMessagePoster = vi.fn();
    const mockSpawner = { async spawn() { return 'session'; } };
    const mockPoller = { async poll() { return { status: 'running' as const }; } };
    const mockNotifier = { async notify() {} };
    const mockKiller = { async kill() {} };

    const opts: WorkflowSingletonOptions = {
      stateDir: '/tmp/test',
      spawner: mockSpawner,
      poller: mockPoller,
      notifier: mockNotifier,
      killer: mockKiller,
      createMessagePoster: mockCreateMessagePoster,
    };

    expect(() => {
      initWorkflow(opts);
    }).not.toThrow();
  });

  it('should accept createToolExecutor factory in options', () => {
    const mockCreateToolExecutor = vi.fn();
    const mockSpawner = { async spawn() { return 'session'; } };
    const mockPoller = { async poll() { return { status: 'running' as const }; } };
    const mockNotifier = { async notify() {} };
    const mockKiller = { async kill() {} };

    const opts: WorkflowSingletonOptions = {
      stateDir: '/tmp/test',
      spawner: mockSpawner,
      poller: mockPoller,
      notifier: mockNotifier,
      killer: mockKiller,
      toolExecutor: mockCreateToolExecutor,
    };

    expect(() => {
      initWorkflow(opts);
    }).not.toThrow();
  });

  it('should pass both createMessagePoster and createToolExecutor factories to WorkflowServer', () => {
    const mockCreateMessagePoster = vi.fn();
    const mockCreateToolExecutor = vi.fn();
    const mockSpawner = { async spawn() { return 'session'; } };
    const mockPoller = { async poll() { return { status: 'running' as const }; } };
    const mockNotifier = { async notify() {} };
    const mockKiller = { async kill() {} };

    const opts: WorkflowSingletonOptions = {
      stateDir: '/tmp/test',
      spawner: mockSpawner,
      poller: mockPoller,
      notifier: mockNotifier,
      killer: mockKiller,
      createMessagePoster: mockCreateMessagePoster,
      toolExecutor: mockCreateToolExecutor,
    };

    const result = initWorkflow(opts);

    expect(result.server).toBeDefined();
    expect(result.controlPlane).toBeDefined();
  });
});
