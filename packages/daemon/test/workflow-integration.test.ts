import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflow, resetWorkflowSingleton } from '../src/workflow-singleton';
import type { WorkflowSingletonOptions } from '../src/workflow-singleton';
import type { MessagePoster } from '@shoggoth/workflow';

describe('Workflow Integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'shoggoth-workflow-int-'));
    vi.clearAllMocks();
    resetWorkflowSingleton();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should accept createMessagePoster factory in options', () => {
    const mockCreateMessagePoster = vi.fn();
    const mockSpawner = { async spawn() { return 'session'; } };
    const mockPoller = { async poll() { return { status: 'running' as const }; } };
    const mockNotifier = { async notify() {} };
    const mockKiller = { async kill() {} };

    const opts: WorkflowSingletonOptions = {
      stateDir: tempDir,
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
      stateDir: tempDir,
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
      stateDir: tempDir,
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

  it('should execute message tasks when createMessagePoster is provided', async () => {
    const postedMessages: Array<{ target: string; message: string }> = [];
    const mockPoster: MessagePoster = {
      async post(target: string, message: string): Promise<void> {
        postedMessages.push({ target, message });
      },
    };

    const mockCreateMessagePoster = vi.fn().mockReturnValue(mockPoster);
    const mockSpawner = { 
      async spawn() { return 'session'; },
      completionMap: new Map(),
      abortTask: () => {},
    };
    const mockPoller = { async poll() { return { status: 'done' as const, output: 'test' }; } };
    const mockNotifier = { async notify() {} };
    const mockKiller = { async kill() {} };

    const opts: WorkflowSingletonOptions = {
      stateDir: tempDir,
      spawner: mockSpawner as any,
      poller: mockPoller,
      notifier: mockNotifier,
      killer: mockKiller,
      createMessagePoster: mockCreateMessagePoster,
    };

    const { server } = initWorkflow(opts);

    // Start a workflow with a message task
    const workflowId = await server.start(
      [
        {
          kind: 'message',
          id: 1,
          message: 'Hello from workflow',
          failureBehavior: 'continue',
          failureNotification: 'silent',
        },
      ],
      '1',
      {
        stateDir: tempDir,
        currentDepth: 0,
        maxDepth: 2,
        replyTo: 'agent:test',
        pollingIntervalMs: 50,
        runtimeLimitMs: 60000,
      },
    );

    // Wait for the workflow to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const status = server.get(workflowId);
    expect(status).toBeDefined();
    expect(postedMessages.length).toBe(1);
    expect(postedMessages[0].message).toBe('Hello from workflow');
  });
});
