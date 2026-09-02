import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { userFacingError } from '../errors/userFacingError.js';

export default function ErrorNotice({ error, context, onRetry, onDismiss, compact = false, className = '' }) {
  if (!error) return null;
  const issue = userFacingError(error, { context });

  return (
    <div className={`error-notice${compact ? ' error-notice-compact' : ''} ${className}`.trim()} role="alert">
      <AlertTriangle className="error-notice-icon" size={18} aria-hidden="true" />
      <div className="error-notice-content">
        <strong>{issue.title}</strong>
        <span>{issue.message}</span>
        <span className="error-notice-action">{issue.action}</span>
        {issue.technicalDetail ? (
          <details className="error-notice-details">
            <summary>Technical details</summary>
            <pre>{issue.technicalDetail}</pre>
          </details>
        ) : null}
      </div>
      <div className="error-notice-buttons">
        {onRetry ? (
          <button type="button" className="error-notice-button" onClick={onRetry}>
            <RefreshCw size={14} /> Retry
          </button>
        ) : null}
        {onDismiss ? (
          <button type="button" className="error-notice-dismiss" onClick={onDismiss} aria-label="Dismiss error">
            <X size={15} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
