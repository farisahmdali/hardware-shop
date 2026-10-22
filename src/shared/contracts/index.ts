import type { z } from 'zod';
import type { CommandDef } from './define';
import { systemCommands } from './system';
import { inventoryCommands } from './inventory';
import { salesCommands } from './sales';
import { rentalCommands } from './rentals';

export const contract = {
  ...systemCommands,
  ...inventoryCommands,
  ...salesCommands,
  ...rentalCommands,
};

export type Contract = typeof contract;
export type CommandName = keyof Contract;
export type CommandInput<K extends CommandName> = z.input<Contract[K]['input']>;
export type ParsedInput<K extends CommandName> = z.output<Contract[K]['input']>;
export type CommandOutput<K extends CommandName> =
  Contract[K] extends CommandDef<z.ZodType, infer O> ? O : never;

export * from './define';
export * from './system';
export * from './inventory';
export * from './sales';
export * from './rentals';
