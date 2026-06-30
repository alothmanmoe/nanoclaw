import { execFileSync } from 'node:child_process';
import { log } from '../../log.js';

function run(cmd: string, args: string[]): { status: number | null; stdout: string } {
  try {
    return { status: 0, stdout: execFileSync(cmd, args, { encoding: 'utf-8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? '' };
  }
}

/** Resolve a vault agent's internal uuid from its identifier (= agent group id).
 *  Returns null if the vault is unreadable or the identifier isn't present. */
export function resolveVaultUuid(identifier: string): string | null {
  const r = run('onecli', ['agents', 'list']);
  if (r.status !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const data = parsed && typeof parsed === 'object' && 'data' in parsed ? (parsed as { data: unknown }).data : null;
  if (!Array.isArray(data)) return null;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    if (a.isDefault === true) continue;
    if (a.identifier === identifier && typeof a.id === 'string') return a.id;
  }
  return null;
}

/** Remove the vault agent for `identifier` (= agent group id). Best-effort. */
export function deleteVaultAgent(identifier: string): void {
  const uuid = resolveVaultUuid(identifier);
  if (!uuid) return; // not in vault or vault unreadable — nothing to remove
  const r = run('onecli', ['agents', 'delete', '--id', uuid]);
  if (r.status !== 0) log.warn('OneCLI vault agent delete failed', { identifier, uuid });
}
