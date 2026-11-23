import { useState } from 'react';
import type { Task, TaskScope } from '../data/types';
import { addDays, formatDay, formatWeek, fromISODate, today, weekStart } from '../lib/dates';
import { useVault } from '../hooks';

export function Tasks({ onMenu }: { onMenu?: () => void }) {
  const vault = useVault();
  const [scope, setScope] = useState<TaskScope>('day');
  const [day, setDay] = useState(today());

  const period = scope === 'day' ? day : weekStart(day);
  const tasks = vault.tasksFor(scope, period);
  const isCurrent = scope === 'day' ? day === today() : period === weekStart(today());
  const overdue = isCurrent ? vault.overdue(scope, period) : [];
  const done = tasks.filter((t) => t.done).length;

  const step = (n: number) => setDay((d) => addDays(d, scope === 'day' ? n : 7 * n));

  return (
    <section className="tasks-pane">
      <header className="pane-head">
        {onMenu && (
          <button className="icon-btn" aria-label="Open menu" onClick={onMenu}>
            ☰
          </button>
        )}
        <h2>Tasks</h2>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={scope === 'day'} className={scope === 'day' ? 'active' : ''} onClick={() => setScope('day')}>
            Daily
          </button>
          <button role="tab" aria-selected={scope === 'week'} className={scope === 'week' ? 'active' : ''} onClick={() => setScope('week')}>
            Weekly
          </button>
        </div>
      </header>

      <div className="tasks-body">
        <div className="period-nav">
          <button className="icon-btn" aria-label="Previous" onClick={() => step(-1)}>
            ‹
          </button>
          <div className="period-title">
            <strong>{scope === 'day' ? formatDay(day) : `Week of ${formatWeek(period)}`}</strong>
            {!isCurrent && (
              <button className="link" onClick={() => setDay(today())}>
                Back to {scope === 'day' ? 'today' : 'this week'}
              </button>
            )}
          </div>
          <button className="icon-btn" aria-label="Next" onClick={() => step(1)}>
            ›
          </button>
        </div>

        {scope === 'week' && <WeekStrip start={period} onPick={(d) => { setDay(d); setScope('day'); }} />}

        <div className="progress" aria-label={`${done} of ${tasks.length} done`}>
          <div className="bar" style={{ width: tasks.length ? `${(done / tasks.length) * 100}%` : 0 }} />
        </div>
        <p className="hint">
          {tasks.length ? `${done} of ${tasks.length} done` : scope === 'day' ? 'Nothing planned for this day.' : 'No goals for this week yet.'}
        </p>

        <AddTask placeholder={scope === 'day' ? 'Add a task for this day…' : 'Add a goal for this week…'} onAdd={(t) => void vault.addTask(t, scope, period)} />

        <ul className="task-list">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>

        {overdue.length > 0 && (
          <div className="overdue">
            <div className="section-head">
              <span>Unfinished from earlier ({overdue.length})</span>
              <button className="link" onClick={() => void vault.moveTasks(overdue.map((t) => t.id), period)}>
                Move all to {scope === 'day' ? 'today' : 'this week'}
              </button>
            </div>
            <ul className="task-list">
              {overdue.map((t) => (
                <TaskRow key={t.id} task={t} showPeriod onMoveHere={() => void vault.moveTasks([t.id], period)} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function WeekStrip({ start, onPick }: { start: string; onPick: (d: string) => void }) {
  const vault = useVault();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const t = today();
  return (
    <div className="week-strip">
      {days.map((d) => {
        const list = vault.tasksFor('day', d);
        const done = list.filter((x) => x.done).length;
        return (
          <button key={d} className={`day-cell ${d === t ? 'today' : ''}`} onClick={() => onPick(d)}>
            <span className="dow">{fromISODate(d).toLocaleDateString(undefined, { weekday: 'short' })}</span>
            <span className="dom">{fromISODate(d).getDate()}</span>
            <span className="cnt">{list.length ? `${done}/${list.length}` : '·'}</span>
          </button>
        );
      })}
    </div>
  );
}

function AddTask({ placeholder, onAdd }: { placeholder: string; onAdd: (title: string) => void }) {
  const [text, setText] = useState('');
  return (
    <form
      className="add-task"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onAdd(text);
        setText('');
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="New task" />
      <button className="primary small" type="submit" disabled={!text.trim()}>
        Add
      </button>
    </form>
  );
}

function TaskRow({ task, showPeriod, onMoveHere }: { task: Task; showPeriod?: boolean; onMoveHere?: () => void }) {
  const vault = useVault();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.title);

  const save = () => {
    setEditing(false);
    if (text.trim() && text !== task.title) void vault.updateTask(task.id, { title: text.trim() });
    else setText(task.title);
  };

  return (
    <li className={`task ${task.done ? 'done' : ''}`}>
      <input type="checkbox" checked={task.done} aria-label={`Mark "${task.title}" ${task.done ? 'not done' : 'done'}`} onChange={() => void vault.updateTask(task.id, { done: !task.done })} />
      {editing ? (
        <input
          className="task-edit"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') {
              setText(task.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="task-title" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
          {task.title}
        </span>
      )}
      {showPeriod && <span className="task-when">{task.scope === 'day' ? formatDay(task.period) : `wk ${formatWeek(task.period)}`}</span>}
      {onMoveHere && (
        <button className="icon-btn" title="Move here" aria-label="Move here" onClick={onMoveHere}>
          ⤵
        </button>
      )}
      <button className="icon-btn" title="Edit" aria-label={`Edit ${task.title}`} onClick={() => setEditing(true)}>
        ✎
      </button>
      <button className="icon-btn" title="Delete" aria-label={`Delete ${task.title}`} onClick={() => void vault.deleteTask(task.id)}>
        ✕
      </button>
    </li>
  );
}
