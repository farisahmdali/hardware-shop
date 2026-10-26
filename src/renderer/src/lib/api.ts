import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type { CommandInput, CommandName, CommandOutput } from '@shared/contracts';
import type { ErrorCode, ErrorPayload, Result } from '@shared/errors';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(payload: ErrorPayload) {
    super(payload.message);
    this.code = payload.code;
    this.details = payload.details;
  }
}

/** Sends one command to the main process. Resolves only after the operation has committed. */
export async function call<K extends CommandName>(name: K, input?: CommandInput<K>): Promise<CommandOutput<K>> {
  const res = (await window.hws.invoke(name, input ?? {})) as Result<CommandOutput<K>>;
  if (!res.ok) throw new ApiError(res.error);
  return res.data;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export function useCommandQuery<K extends CommandName>(
  name: K,
  input?: CommandInput<K>,
  options?: Omit<UseQueryOptions<CommandOutput<K>, ApiError>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<CommandOutput<K>, ApiError>({
    queryKey: [name, input ?? {}],
    queryFn: () => call(name, input),
    ...options,
  });
}

/**
 * A mutation that, once it has committed, refreshes every query whose command name
 * starts with one of `invalidate` (e.g. 'settings.' or 'backup.list'). The history,
 * dashboard and reports are always refreshed, because every change can affect them.
 */
export function useCommandMutation<K extends CommandName>(name: K, opts: { invalidate?: string[] } = {}) {
  const qc = useQueryClient();
  const prefixes = ['audit.', 'dashboard.', 'reports.', ...(opts.invalidate ?? [])];
  return useMutation<CommandOutput<K>, ApiError, CommandInput<K>>({
    mutationFn: (input) => call(name, input),
    onSettled: async () => {
      // Also on failure: denied or failed attempts can be recorded in the history too.
      await qc.invalidateQueries({
        predicate: (q) => prefixes.some((prefix) => String(q.queryKey[0]).startsWith(prefix)),
      });
    },
  });
}
