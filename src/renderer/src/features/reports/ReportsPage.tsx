import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, ChevronRight, Search } from 'lucide-react';
import { REPORT_GROUPS, REPORTS, canRunReport } from '@shared/reports';
import { useSession } from '../../lib/session';
import { Input } from '../../components/ui/form';
import { Card, EmptyState, PageHeader } from '../../components/ui/layout';

/** All reports the user may run, by group, with a search box. */
export function ReportsPage() {
  const session = useSession();
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const allowed = REPORTS.filter((r) => canRunReport(r, session.permissions));
  const matches = allowed.filter((r) => !q || `${r.title} ${r.description}`.toLowerCase().includes(q));

  return (
    <>
      <PageHeader
        title="Reports"
        description="Worked out from the records each time you open them. Export to Excel, CSV or PDF, or print."
        actions={
          <div className="relative w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <Input aria-label="Search reports" placeholder="Find a report…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          </div>
        }
      />
      {allowed.length === 0 ? (
        <EmptyState icon={BarChart3} title="No reports for your role" description="Ask the owner for report access." />
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {REPORT_GROUPS.map((g) => {
            const list = matches.filter((r) => r.groups.includes(g.id));
            if (list.length === 0) return null;
            return (
              <Card key={g.id}>
                <div className="border-b border-line px-5 py-3.5">
                  <h2 className="text-[15px] font-semibold text-ink">{g.title}</h2>
                  <p className="text-[13px] text-ink-3">{g.description}</p>
                </div>
                <ul className="divide-y divide-line">
                  {list.map((r) => (
                    <li key={r.id}>
                      <Link to={`/reports/${r.id}`} className="group flex items-center justify-between gap-4 px-5 py-2.5 hover:bg-surface-2">
                        <span className="min-w-0">
                          <span className="block font-medium text-ink group-hover:text-brand">{r.title}</span>
                          <span className="block truncate text-[13px] text-ink-3">{r.description}</span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-ink-3" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
      {allowed.length > 0 && matches.length === 0 && <p className="mt-6 text-center text-ink-3">No report matches “{search}”.</p>}
    </>
  );
}
