import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useTechniqueSession } from '../components/TechniqueSessionProvider';
import { useRightDock } from '../components/RightDockProvider';
import { TechniqueMatDock } from '../components/TechniqueMatDock';

// New/edit technique controller: chat is the surface; mount starts the session + dock, unmount ends both.
export function TechniqueSessionRoute() {
  const { id } = useParams<{ id?: string }>();
  const { start, end } = useTechniqueSession();
  const { open, close } = useRightDock();

  useEffect(() => {
    const mode = id ? 'edit' : 'new';
    start(mode, id);
    open({ kind: 'panel', title: 'Technique Mat', content: <TechniqueMatDock /> });
    return () => {
      end();
      close();
    };
    // Re-run only when the technique identity changes (new vs a specific edit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return null;
}
