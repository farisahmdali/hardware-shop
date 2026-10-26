import { ZodError } from 'zod';
import { contract, type CommandName, type CommandOutput, type ParsedInput } from '@shared/contracts';
import { AppError, ErrorCodes, type Result } from '@shared/errors';
import type { Permission } from '@shared/permissions';
import type { SessionInfo } from '@shared/contracts';
import type { Actor } from '../db/tx';
import type { AppEnv } from '../services/env';
import { actorFromSession, recordDenied } from '../services/auth';

/** 'public' commands run without a session; 'authenticated' needs any signed-in user. */
export type Access = 'public' | 'authenticated' | Permission;

export interface HandlerContext {
  env: AppEnv;
  session: SessionInfo | null;
  actor: Actor;
  /** Opaque id of the calling window; used to keep one session per window. */
  senderId: number;
  setSessionUser(userId: number | null): void;
}

export interface HandlerDef<K extends CommandName> {
  access: Access;
  handle(input: ParsedInput<K>, ctx: HandlerContext): CommandOutput<K> | Promise<CommandOutput<K>>;
}

export type HandlerMap = { [K in CommandName]?: HandlerDef<K> };

export interface DispatcherDeps {
  env: AppEnv;
  handlers: HandlerMap;
  getSession(senderId: number): SessionInfo | null;
  setSessionUser(senderId: number, userId: number | null): void;
}

/** Turns SQLite constraint failures into messages a shop user can act on. */
function mapDatabaseError(e: unknown): AppError | null {
  const err = e as { code?: string; message?: string };
  if (typeof err?.code !== 'string' || !err.code.startsWith('SQLITE_')) return null;
  const msg = err.message ?? '';
  if (msg.includes('ASSET_DOUBLE_BOOKED')) {
    return new AppError(ErrorCodes.BUSINESS_RULE, 'That rental unit is already booked for an overlapping period.');
  }
  if (msg.includes('STOCK_OUT_OF_SYNC')) {
    return new AppError(ErrorCodes.CONFLICT, 'Stock changed while this was being saved. Please try again.');
  }
  if (msg.includes('IMMUTABLE')) {
    return new AppError(ErrorCodes.BUSINESS_RULE, 'Finalized records cannot be changed. Use a correction instead.');
  }
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return new AppError(ErrorCodes.CONFLICT, 'A record with the same unique value already exists.', { detail: msg });
  }
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return new AppError(ErrorCodes.CONFLICT, 'The operation refers to a record that does not exist or is still in use.');
  }
  if (err.code.startsWith('SQLITE_CONSTRAINT')) {
    return new AppError(ErrorCodes.VALIDATION, 'The data did not pass a database check.', { detail: msg });
  }
  if (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED') {
    return new AppError(ErrorCodes.CONFLICT, 'The database is busy. Please try again in a moment.');
  }
  if (err.code === 'SQLITE_FULL') {
    return new AppError(ErrorCodes.IO, 'The disk is full. Free some space; nothing was saved.');
  }
  return null;
}

export function createDispatcher(deps: DispatcherDeps) {
  return async function dispatch(senderId: number, command: unknown, rawInput: unknown): Promise<Result<unknown>> {
    const name = command as CommandName;
    try {
      if (typeof command !== 'string' || !Object.hasOwn(contract, command) || !deps.handlers[name]) {
        throw new AppError(ErrorCodes.UNKNOWN_COMMAND, `Unknown command: ${String(command)}`);
      }
      const handler = deps.handlers[name] as HandlerDef<CommandName>;
      const session = deps.getSession(senderId);
      const actor = actorFromSession(session);

      if (handler.access !== 'public') {
        if (!session) throw new AppError(ErrorCodes.UNAUTHENTICATED, 'Please sign in again.');
        if (handler.access !== 'authenticated' && !session.permissions.includes(handler.access)) {
          throw new AppError(ErrorCodes.PERMISSION_DENIED, 'You do not have permission to do this.', {
            permission: handler.access,
          });
        }
      }

      const input = contract[name].input.parse(rawInput ?? {}) as ParsedInput<CommandName>;
      const data = await handler.handle(input, {
        env: deps.env,
        session,
        actor,
        senderId,
        setSessionUser: (userId) => deps.setSessionUser(senderId, userId),
      });
      return { ok: true, data: data ?? null };
    } catch (e) {
      if (e instanceof AppError) {
        // Every refused attempt is recorded, whether refused here or by a check inside the command
        // (a discount above the role's limit, a report the role may not see, ...).
        if (e.code === ErrorCodes.PERMISSION_DENIED) {
          try {
            const actor = actorFromSession(deps.getSession(senderId));
            const permission = (e.details as { permission?: string } | undefined)?.permission ?? e.message;
            recordDenied(deps.env, actor, String(command), permission);
          } catch (logError) {
            deps.env.logger.error('Could not record a refused action', logError);
          }
        }
        return { ok: false, error: e.toPayload() };
      }
      if (e instanceof ZodError) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.VALIDATION,
            message: e.issues[0]?.message ?? 'Some fields are not valid.',
            details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        };
      }
      const mapped = mapDatabaseError(e);
      if (mapped) {
        deps.env.logger.warn(`Command ${String(command)} failed: ${(e as Error).message}`);
        return { ok: false, error: mapped.toPayload() };
      }
      deps.env.logger.error(`Command ${String(command)} crashed`, e);
      return {
        ok: false,
        error: {
          code: ErrorCodes.INTERNAL,
          message: 'Something went wrong and nothing was saved. The error has been logged.',
        },
      };
    }
  };
}
