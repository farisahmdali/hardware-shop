import { CheckCircle2 } from 'lucide-react';
import type { NavItem } from '../../layout/nav';
import { Badge, Card, PageHeader } from '../../components/ui/layout';

/** Shown for modules that are scheduled for a later build phase. Deliberately has no inactive buttons. */
export function ModulePlaceholder({ item }: { item: NavItem }) {
  const info = item.placeholder!;
  return (
    <>
      <PageHeader title={item.label} description={info.summary} />
      <Card className="max-w-2xl p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <item.icon className="size-5" />
          </div>
          <div>
            <p className="font-semibold text-ink">This module is being built</p>
            <Badge tone="info">Planned for phase {info.phase}</Badge>
          </div>
        </div>
        <p className="mb-3 text-ink-2">When it is ready, this screen will let you:</p>
        <ul className="flex flex-col gap-2">
          {info.features.map((f) => (
            <li key={f} className="flex items-start gap-2 text-ink">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ink-3" />
              {f}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
