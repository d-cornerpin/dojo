import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import * as api from '../lib/api';

export const Login = () => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const check = async () => {
      const result = await api.getSetupStatus();
      if (result.ok) {
        setIsFirstRun(result.data.isFirstRun);
      } else {
        setIsFirstRun(false);
      }
    };
    check();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;

    setIsSubmitting(true);
    setError(null);

    const loginError = await login(password);
    if (loginError) {
      setError(loginError);
      setIsSubmitting(false);
      return;
    }

    const setupResult = await api.getSetupStatus();
    if (setupResult.ok && setupResult.data.isFirstRun) {
      navigate('/setup');
    } else {
      navigate('/');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative">
      <div className="gradient-blob-layer">
        <div className="blob blob-purple" />
        <div className="blob blob-teal" />
        <div className="blob blob-warm" />
      </div>
      <div className="w-full max-w-sm relative z-[1] animate-fade-up">
        {/* Logo */}
        <div className="text-center mb-8">
          <img src="/dojologo.svg" alt="DOJO" className="w-14 h-14 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white tracking-wide">Agent D.O.J.O.</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>Delegated Operations & Job Orchestration</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="glass-card p-6">
          <div className="mb-5">
            {isFirstRun ? (
              <>
                <h2 className="text-sm font-semibold text-white mb-1">Create Your Dashboard Password</h2>
                <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
                  This password protects your DOJO dashboard. You'll use it each time you log in.
                </p>
              </>
            ) : (
              <label htmlFor="password" className="block text-sm font-medium text-white/80 mb-2">Password</label>
            )}
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isFirstRun ? 'Create a password' : 'Enter your password'}
              autoFocus
              className="glass-input"
            />
          </div>

          {error && (
            <div className="mb-4 px-3 py-2.5 rounded-glass-xs glass-badge-coral text-sm" style={{ background: 'rgba(255, 107, 138, 0.1)', border: '1px solid rgba(255, 107, 138, 0.2)' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || !password.trim()}
            className="glass-btn glass-btn-primary w-full py-3"
          >
            {isSubmitting ? 'Signing in...' : isFirstRun ? 'Set Password & Continue' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};
