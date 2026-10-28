// ════════════════════════════════════════════════════════════════════════════
// A NEW PROJECT'S TASKS SHOW THE ASSIGNEE THE OWNER ACTUALLY PICKED.
//
// `CreateProjectModal` starts `taskAssignee` at `''` and sends
// `assignedTo: t.assignedTo || undefined`, so a task added without touching the
// select is created UNASSIGNED. But both selects that edit it — the add-task
// select and the row select on each added task — listed only the agents. With no
// empty option, React shows the first option when the value matches none, so the
// owner saw an agent's name on screen while the task shipped unassigned: the
// display promised work that nothing would do.
//
// The sibling `CreateTaskModal` already carries `<option value="">Unassigned
// </option>`; this is that truth on the project form. The door calls are mocked,
// so what is asserted here is exactly what the owner sees and what goes out.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
    ToastContainer: () => null,
  };
});

import * as api from '../lib/api';
import { AuthProvider } from '../hooks/useAuth';
import { Tracker } from '../pages/Tracker';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';

/** The shell `App.tsx` puts every page inside — same nesting as the smoke floor. */
const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider>
      <ThemeProvider>
        <OrbProvider>
          <ActiveAgentProvider>
            <RightDockProvider>
              <TechniqueSessionProvider>
                {page}
              </TechniqueSessionProvider>
            </RightDockProvider>
          </ActiveAgentProvider>
        </OrbProvider>
      </ThemeProvider>
    </AuthProvider>
  </MemoryRouter>
);

const mocked = () => vi.mocked(api);

/** The option the select actually displays — what the owner reads as the assignee. */
const shown = (s: HTMLSelectElement) => s.options[s.selectedIndex]?.textContent ?? '';

/** Every select whose options list the agent, i.e. every assignee picker. */
const assigneeSelects = (): HTMLSelectElement[] =>
  screen.getAllByRole('combobox').filter((s) =>
    Array.from((s as HTMLSelectElement).options).some((o) => o.textContent === 'Helper')) as HTMLSelectElement[];

/** Renders the page, opens the modal, fills the project title and one task,
 *  clicks Add, and returns the two assignee selects the task now has. */
const openModalAndAddTask = async (): Promise<{ rowSelect: HTMLSelectElement; addSelect: HTMLSelectElement }> => {
  render(shell(<Tracker />));
  fireEvent.click(await screen.findByRole('button', { name: '+ Create Project' }));
  fireEvent.change(screen.getByPlaceholderText('Project title'), { target: { value: 'Ship it' } });
  fireEvent.change(screen.getByPlaceholderText('Add a task...'), { target: { value: 'Do it' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));

  const row = screen.getByText('Do it').closest('div') as HTMLElement;
  const rowSelect = within(row).getByRole('combobox') as HTMLSelectElement;
  const addSelect = assigneeSelects().find((s) => !row.contains(s)) as HTMLSelectElement;
  return { rowSelect, addSelect };
};

beforeEach(() => {
  resetFrames();
  mocked().getProjects.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getAgents.mockResolvedValue({
    ok: true,
    data: [{ id: 'a1', name: 'Helper', status: 'idle', agentType: 'standard' }],
  } as never);
  mocked().getTasks.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getOverrideRequests.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getTrackerHygiene.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().createProject.mockResolvedValue({ ok: true, data: { projectId: 'p', taskIds: [] } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('a task added to a new project shows its real assignee', () => {
  it('the add-task select shows Unassigned while nothing was picked', async () => {
    const { addSelect } = await openModalAndAddTask();

    expect(addSelect.value, 'nothing was picked, so the value is empty').toBe('');
    expect(shown(addSelect), 'the owner sees an agent chosen while the task ships unassigned')
      .toBe('Unassigned');
  });

  it('the new task row shows Unassigned too', async () => {
    const { rowSelect } = await openModalAndAddTask();

    expect(rowSelect.value).toBe('');
    expect(shown(rowSelect), 'the row shows an agent chosen that was never picked')
      .toBe('Unassigned');
  });

  it('Create Project sends the task with no assignee', async () => {
    await openModalAndAddTask();
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => expect(mocked().createProject).toHaveBeenCalledTimes(1));
    const [body] = mocked().createProject.mock.calls[0];
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks?.[0].assignedTo).toBeUndefined();
  });

  it('a picked agent on the row reaches the door', async () => {
    const { rowSelect } = await openModalAndAddTask();
    fireEvent.change(rowSelect, { target: { value: 'a1' } });
    expect(shown(rowSelect)).toBe('Helper');

    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));
    await waitFor(() => expect(mocked().createProject).toHaveBeenCalledTimes(1));
    const [body] = mocked().createProject.mock.calls[0];
    expect(body.tasks?.[0].assignedTo).toBe('a1');
  });
});
