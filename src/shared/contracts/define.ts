import type { z } from 'zod';

/**
 * A command definition: a zod schema for its input and a phantom type for its output.
 * Main validates every input against the schema; the renderer gets end-to-end types.
 */
export interface CommandDef<I extends z.ZodType, O> {
  input: I;
  /** Type-only marker; never set at runtime. */
  readonly __output?: O;
}

export const command =
  <O>() =>
  <I extends z.ZodType>(input: I): CommandDef<I, O> => ({ input });

export type Paged<T> = { rows: T[]; total: number; page: number; pageSize: number };
