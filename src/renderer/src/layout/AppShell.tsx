import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Hammer, LogOut, WifiOff } from 'lucide-react';
import type { AppStatus } from '@shared/contracts';
import { call, errorMessage } from '../lib/api';
import { useCan, useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { cn } from '../lib/cn';
import { NAV_ITEMS } from './nav';

export function AppShell({ status, shopName, children }: { status: AppStatus; shopName: string; children: ReactNode }) {
  const session = useSession();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();

  const signOut = async () => {
    try {
      await call('auth.logout');
      qc.clear();
      await qc.invalidateQueries();
    } catch (e) {
      toast.error('Could not sign out', errorMessage(e));
    }
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-text">
        <div className="flex items-center gap-3 px-5 pt-5 pb-4">
          <div className="flex size-9 items-center justify-center rounded-lg bg-accent text-white">
            <Hammer className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-semibold text-white" title={shopName}>
              {shopName || 'Hardware Shop'}
            </p>
            <p className="flex items-center gap-1 text-[12px] text-sidebar-muted">
              <WifiOff className="size-3" /> Offline · v{status.appVersion}
            </p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label="Main">
          <ul className="flex flex-col gap-0.5">
            {NAV_ITEMS.filter((n) => !n.permission || can(n.permission)).map((item) => (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-md px-3 py-2 font-medium transition-colors',
                      isActive ? 'bg-sidebar-active text-white' : 'hover:bg-sidebar-active/60 hover:text-white',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <item.icon className={cn('size-[18px] shrink-0', isActive ? 'text-accent' : 'text-sidebar-muted')} />
                      <span className="truncate">{item.label}</span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-white/10 px-3 py-3">
          <div className="flex items-center gap-3 rounded-md px-2 py-1.5">
            <div className="flex size-8 items-center justify-center rounded-full bg-sidebar-active text-[13px] font-semibold text-white">
              {session.user.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-white">{session.user.displayName}</p>
              <p className="truncate text-[12px] text-sidebar-muted">{session.user.roleName}</p>
            </div>
            {status.requireLogin && (
              <button
                type="button"
                onClick={signOut}
                className="rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-active hover:text-white"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            )}
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {status.startupWarnings.length > 0 && (
          <div role="alert" className="flex items-start gap-2 border-b border-warning/30 bg-warning-soft px-8 py-2.5 text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              The startup data check found a problem: {status.startupWarnings[0]} Open Backup &amp; Settings → Data health for
              details.
            </span>
          </div>
        )}
        <div className="mx-auto max-w-[1400px] px-8 py-7">{children}</div>
      </main>
    </div>
  );
}
