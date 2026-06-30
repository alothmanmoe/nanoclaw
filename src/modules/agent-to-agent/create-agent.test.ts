/**
 * Tests for create_agent host-side behavior.
 *
 * Spawning no longer requires approval. Any agent may create sub-agents
 * directly, subject to the fleet cap (MAX_MANAGED_AGENTS). These tests pin:
 *   - always creates directly, never requests approval
 *   - records parent + lifetime on every create
 *   - fleet cap rejects without creating
 *   - provider inheritance is unchanged
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

// Mocks for collaborators.
const mockRequestApproval = vi.fn().mockResolvedValue(undefined);
const mockGetContainerConfig = vi.fn();
const mockCreateAgentGroup = vi.fn();
const mockInitGroupFilesystem = vi.fn();
const mockUpdateScalars = vi.fn();
const mockWriteDestinations = vi.fn();
const mockNotifyWrite = vi.fn();
const mockCountLiveTaskAgents = vi.fn(() => 0);

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
  ensureContainerConfig: () => {},
  updateContainerConfigScalars: (...a: unknown[]) => mockUpdateScalars(...a),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: (...a: unknown[]) => mockCreateAgentGroup(...a),
  countLiveTaskAgents: () => mockCountLiveTaskAgents(),
}));
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...a: unknown[]) => mockInitGroupFilesystem(...a),
}));
vi.mock('./write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
vi.mock('./db/agent-destinations.js', () => ({
  getDestinationByName: () => undefined,
  createDestination: vi.fn(),
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
// notifyAgent writes to the session inbound.db + wakes the container; stub both.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
}));

import { handleCreateAgent } from './create-agent.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

beforeEach(() => {
  vi.clearAllMocks();
  mockCountLiveTaskAgents.mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleCreateAgent — no approval gate', () => {
  it('global scope: creates directly, no approval requested', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
    expect(mockInitGroupFilesystem).toHaveBeenCalledTimes(1);
  });

  it('group scope (default): creates directly, does NOT request approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('missing config: creates directly, no approval', async () => {
    mockGetContainerConfig.mockReturnValue(undefined);

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('disabled/other scope: creates directly, no approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('empty name: neither creates nor requests approval', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: '' }, SESSION);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('child inherits the creator provider (codex parent → codex child)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global', provider: 'codex' });

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockInitGroupFilesystem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'codex' }),
    );
    expect(mockUpdateScalars).toHaveBeenCalledWith(expect.any(String), { provider: 'codex' });
  });

  it('claude creator leaves the child provider unset (built-in default)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' }); // no provider

    await handleCreateAgent({ name: 'Scout', instructions: 'help' }, SESSION);

    expect(mockUpdateScalars).not.toHaveBeenCalled();
  });

  it('records parent and default lifetime task', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockCreateAgentGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentAgentGroupId: 'ag-1', lifetime: 'task' }),
    );
  });

  it('lifetime persistent when requested', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    await handleCreateAgent({ name: 'Scout', lifetime: 'persistent' }, SESSION);

    expect(mockCreateAgentGroup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lifetime: 'persistent' }),
    );
  });

  it('fleet cap: rejects without creating', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockCountLiveTaskAgents.mockReturnValue(100);

    await handleCreateAgent({ name: 'Scout' }, SESSION);

    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockNotifyWrite).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        content: expect.stringContaining('fleet cap'),
      }),
    );
  });
});
