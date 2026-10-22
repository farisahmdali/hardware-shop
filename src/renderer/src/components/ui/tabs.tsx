import type { ReactNode } from 'react';
import * as RT from '@radix-ui/react-tabs';
import { cn } from '../../lib/cn';

export const Tabs = RT.Root;
export const TabsContent = RT.Content;

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <RT.List className={cn('flex gap-1 border-b border-line', className)}>{children}</RT.List>;
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RT.Trigger
      value={value}
      className={cn(
        '-mb-px border-b-2 border-transparent px-3.5 py-2.5 font-medium text-ink-3 transition-colors hover:text-ink',
        'data-[state=active]:border-brand data-[state=active]:text-brand',
      )}
    >
      {children}
    </RT.Trigger>
  );
}
