import { NavLink } from 'react-router-dom';
import { type ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLeads, useLeadsStatus } from '../store/useLeads';
import { isActiveLead, isClient, isFinancingClient, isOnBoard } from '../lib/leadFlow';
import { paymentPastDue } from '../lib/dates';

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const leads = useLeads();

  const todayEnd = (() => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  })();
  const counts = {
    today: leads.reduce((n, l) => {
      if (!isActiveLead(l)) return n + (isClient(l) && paymentPastDue(l) ? 1 : 0);
      const uncontacted = (l.contactAttempts?.length ?? 0) === 0 ? 1 : 0;
      const due = (l.followUps ?? []).filter((f) => !f.done && f.dueAt <= todayEnd).length;
      const stalled =
        (l.contactAttempts?.length ?? 0) > 0 && !(l.followUps ?? []).some((f) => !f.done) ? 1 : 0;
      return n + uncontacted + due + stalled;
    }, 0),
    board: leads.filter(isOnBoard).length,
    command: leads.filter((l) => l.stage === 'callback' || l.stage === 'nurture' || l.stage === 'attorney_call').length,
    financing: leads.filter(isFinancingClient).length,
    completed: leads.filter((l) => l.stage === 'intake_complete').length,
    noSale: leads.filter((l) => l.stage === 'lost').length,
    followups: leads.reduce(
      (n, l) => n + (l.followUps?.filter((f) => !f.done).length ?? 0),
      0,
    ),
  };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/10 bg-black/30 p-4 md:flex">
        <div className="mb-5 px-2">
          <h1 className="font-hand text-4xl text-white">TVCHub</h1>
          <p className="font-type text-[10px] uppercase tracking-widest text-manila/50">
            Intake · Sales
          </p>
        </div>
        <nav className="flex-1 space-y-1">
          <Item to="/" label="Home" count={counts.today} icon="house" />
          <Item to="/command-center" label="Command Center" count={counts.command} icon="phone-call" />
          <Item to="/calendar" label="Calendar" count={counts.followups} icon="calendar" />
          <Item to="/financing" label="Finance" count={counts.financing} icon="wallet" />
          <Item to="/completed" label="Intake Complete" count={counts.completed} icon="circle-check" />
          <Item to="/no-sale" label="No Sale" count={counts.noSale} icon="ban" />
          <Item to="/reports" label="Reports" count={0} icon="bar-chart-3" />
          <Item to="/archived" label="Archived" count={0} icon="archive" />
        </nav>
        <div className="border-t border-white/10 pt-3">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 font-type text-sm text-manila/70 hover:bg-white/10 hover:text-white ${
                isActive ? 'bg-white/10 text-white' : ''
              }`
            }
          >
            <NavIcon name="settings" />
            <span>Settings</span>
          </NavLink>
          <p className="truncate px-2 font-type text-xs text-manila/60">
            {user?.email}
          </p>
          <button
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-left font-type text-sm text-manila/70 hover:bg-white/10 hover:text-white"
            onClick={() => signOut()}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* mobile top nav */}
      <div className="flex w-full flex-col">
        <div className="flex items-center gap-2 overflow-x-auto border-b border-white/10 bg-black/30 px-3 py-2 md:hidden">
          <Item to="/" label="Home" count={counts.today} icon="house" mobile />
          <Item to="/command-center" label="Sales" count={counts.command} icon="phone-call" mobile />
          <Item to="/calendar" label="Cal" count={counts.followups} icon="calendar" mobile />
          <Item to="/financing" label="Finance" count={counts.financing} icon="wallet" mobile />
          <Item to="/completed" label="Done" count={counts.completed} icon="circle-check" mobile />
          <Item to="/no-sale" label="No Sale" count={counts.noSale} icon="ban" mobile />
          <Item to="/reports" label="Reports" count={0} icon="bar-chart-3" mobile />
          <Item to="/archived" label="Archived" count={0} icon="archive" mobile />
          <Item to="/settings" label="Settings" count={0} icon="settings" mobile />
        </div>
        <main className="flex-1 p-5 sm:p-8">
          <LeadsHealthBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

// Surfaces a problem with the realtime leads feed so staff never stare at a
// silently-empty or silently-truncated desk.
function LeadsHealthBanner() {
  const { error, capped } = useLeadsStatus();
  if (!error && !capped) return null;
  return (
    <div
      className={`mb-4 rounded-lg border px-4 py-3 font-type text-sm ${
        error
          ? 'border-red-500/50 bg-red-500/15 text-red-100'
          : 'border-amber-500/50 bg-amber-500/15 text-amber-100'
      }`}
    >
      {error ? (
        <>
          <span className="font-bold">Couldn't load leads.</span> The live feed
          hit an error ({error}). Check your connection and refresh — if it
          persists it may be a permissions or index issue.
        </>
      ) : (
        <>
          <span className="font-bold">Showing the most recent 5,000 leads.</span>{' '}
          Older records are hidden from live views. Let your admin know so we can
          move to paged loading.
        </>
      )}
    </div>
  );
}

// Renders a Lucide icon from the Iconify public CDN as a CSS mask so it
// inherits the link's text color (manila when idle, white when active).
function NavIcon({ name }: { name: string }) {
  const url = `https://api.iconify.design/lucide/${name}.svg`;
  return (
    <span
      aria-hidden
      className="h-4 w-4 shrink-0 bg-current"
      style={{
        maskImage: `url(${url})`,
        WebkitMaskImage: `url(${url})`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  );
}

function Item({
  to,
  label,
  count,
  icon,
  mobile,
}: {
  to: string;
  label: string;
  count: number;
  icon: string;
  mobile?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        `${mobile ? 'whitespace-nowrap' : ''} nav-link ${isActive ? 'nav-link-active' : ''}`
      }
    >
      <NavIcon name={icon} />
      <span className="flex-1">{label}</span>
      {count > 0 && (
        <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-bold text-white">
          {count}
        </span>
      )}
    </NavLink>
  );
}
