import { useState } from 'react';
import { useUI } from '../store/useUI';
import { TodayView } from './TodayView';
import { NotepadBoard } from './NotepadBoard';

type HomeTab = 'todo' | 'active';

// One home destination with two lenses on the same active leads:
//   To-Do      -> the prioritized work queue (what needs you now)
//   All Active -> the browsable desk (search / sort / grid / focus)
export function HomeView() {
  const openNewLead = useUI((s) => s.openNewLead);
  const [tab, setTab] = useState<HomeTab>('active');

  const tabClass = (active: boolean) =>
    `rounded-md px-4 py-1.5 font-hand text-2xl leading-none transition ${
      active ? 'bg-white/15 text-white' : 'text-manila/60 hover:text-white'
    }`;

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg bg-black/20 p-1">
          <button className={tabClass(tab === 'todo')} onClick={() => setTab('todo')}>
            To-Do
          </button>
          <button className={tabClass(tab === 'active')} onClick={() => setTab('active')}>
            All Active
          </button>
        </div>
        <button className="btn-primary" onClick={openNewLead}>
          + New Lead
        </button>
      </header>

      {tab === 'todo' ? <TodayView embedded /> : <NotepadBoard embedded />}
    </div>
  );
}
