import { useEffect, useState } from 'react';
import type { Lead } from '../types';
import { watchArchivedLeads } from '../lib/db';
import { restoreLead } from '../lib/actions';
import { STAGE_LABELS } from '../lib/leadFlow';
import { fmtDate } from '../lib/dates';

export function ArchivedView() {
  const [items, setItems] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = watchArchivedLeads((leads) => {
      setItems(leads);
      setLoading(false);
    });
    return unsub;
  }, []);

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-hand text-4xl text-white">Archived</h1>
        <p className="text-manila/70 text-sm">
          Files you've archived. Restoring one returns it to its lists; archiving
          never destroys data.
        </p>
      </header>

      {loading ? (
        <p className="rounded-xl bg-black/20 p-10 text-center font-type text-sm text-manila/50">
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="rounded-xl bg-black/20 p-10 text-center font-type text-sm text-manila/50">
          Nothing archived.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-manila/95 shadow-card">
          <table className="w-full text-left font-type text-sm">
            <thead className="bg-black/5 text-xs uppercase tracking-wide text-pad-inkSoft">
              <tr>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Stage when archived</th>
                <th className="px-4 py-3">Court</th>
                <th className="px-4 py-3">Archived</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.id} className="border-t border-black/5 text-pad-ink">
                  <td className="px-4 py-3">
                    <div className="font-semibold">{l.name}</div>
                    <div className="text-xs text-pad-inkSoft">TVC #{l.tvcCaseNumber || '—'}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">{STAGE_LABELS[l.stage] ?? l.stage}</td>
                  <td className="px-4 py-3">{fmtDate(l.nextCourtDate)}</td>
                  <td className="px-4 py-3 text-xs">
                    {l.deletedAt ? new Date(l.deletedAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      className="btn bg-pad-ink px-3 py-1 text-xs text-pad-paper hover:bg-pad-inkSoft"
                      onClick={() => restoreLead(l)}
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
