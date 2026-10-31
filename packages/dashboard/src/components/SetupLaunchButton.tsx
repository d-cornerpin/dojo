// The setup wizard's final "Enter" button: finishes setup, and stays on the wizard with the server's
// reason when setup is refused.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';

export const LaunchButton = () => {
  const navigate = useNavigate();
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const handleLaunch = async () => {
    setLaunching(true);
    setLaunchError(null);
    const r = await api.completeSetup();
    if (!r.ok) {
      setLaunchError(r.error);
      setLaunching(false);
      return;
    }
    navigate('/');
  };

  return (
    <>
      <button onClick={handleLaunch} disabled={launching}
        className="btn btn--primary disabled:opacity-30 disabled:cursor-not-allowed">
        {launching ? 'Entering…' : 'Enter'}
      </button>
      {launchError && <div className="mt-3 px-3 py-2 rounded-lg bg-cp-coral/10 border border-cp-coral/20 text-cp-coral text-sm">{launchError}</div>}
    </>
  );
};
