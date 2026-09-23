import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LogIn, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/useAuth.js';
import ErrorNotice from './ErrorNotice';
import LanguageSwitcher from './LanguageSwitcher';

export default function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const redirectTo = location.state?.from?.pathname || '/dashboard';

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err?.message ? err : t('login.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="bg-pattern"></div>

      <LanguageSwitcher className="login-language-switcher" />

      <div className="login-shell">
        <div className="login-brand">
          <div className="login-logo">
            <img src="/favicon.png" alt={t('app.fullName')} />
          </div>
          <div>
            <h1 className="title login-title">{t('app.name')}</h1>
            <p className="subtitle">{t('app.tagline')}</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="glass-card login-card">
          <div className="login-card-heading">
            <h2>{t('login.welcome')}</h2>
            <p className="subtitle">{t('login.intro')}</p>
          </div>

          <label className="login-field">
            <span>{t('login.username')}</span>
            <input
              className="filter-select login-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
              placeholder={t('login.usernamePlaceholder')}
              dir="ltr"
            />
          </label>

          <label className="login-field">
            <span>{t('login.password')}</span>
            <div className="login-password-wrap">
              <input
                className="filter-select login-input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                placeholder="••••••••"
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          <ErrorNotice error={error} context={t('login.errorContext')} compact />

          <button type="submit" className="btn-primary login-submit" disabled={submitting}>
            {submitting ? <RefreshCw size={16} className="icon-spin" /> : <LogIn size={16} className="icon-flip-rtl" />}
            {submitting ? t('login.submitting') : t('login.submit')}
          </button>
        </form>

        <p className="login-footnote">{t('login.footnote')}</p>
      </div>
    </div>
  );
}
