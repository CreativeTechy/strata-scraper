const TECHNICAL_PATTERN = /(HTTP\s*\d{3}|Traceback|stack trace|<!doctype|<html|Headers?:\s*\{|ECONN|ENOTFOUND|API[_ ]?(KEY|TOKEN)|\.env\b)/i;

function rawMessage(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input)) return input.map(rawMessage).filter(Boolean).join(' ');
  if (typeof input === 'object') {
    if (typeof input.message === 'string') return input.message.trim();
    if (typeof input.error === 'string') return input.error.trim();
    if (typeof input.detail === 'string') return input.detail.trim();
    if (Array.isArray(input.detail)) {
      return input.detail
        .map((item) => item?.msg || item?.message || rawMessage(item))
        .filter(Boolean)
        .join(' ');
    }
  }
  return '';
}

export function userFacingError(input, { context = 'complete this action' } = {}) {
  const raw = rawMessage(input);
  const lower = raw.toLowerCase();
  const result = {
    title: 'Something went wrong',
    message: `We couldn't ${context}.`,
    action: 'Try again. If the problem continues, contact an administrator.',
    technicalDetail: TECHNICAL_PATTERN.test(raw) ? raw : '',
  };

  if (/invalid (username|password|credentials)|incorrect (username|password)|login failed/.test(lower)) {
    return { ...result, title: 'Sign-in failed', message: 'The username or password is incorrect.', action: 'Check your details and try again.', technicalDetail: '' };
  }
  if (/unauthori[sz]ed|session.*(expired|invalid)|csrf|\b401\b/.test(lower)) {
    return { ...result, title: 'Session expired', message: 'Your session is no longer active.', action: 'Sign in again, then retry the action.' };
  }
  if (/forbidden|permission|access denied|\b403\b/.test(lower)) {
    return { ...result, title: 'Permission required', message: `You don't have permission to ${context}.`, action: 'Ask an administrator for the required access.' };
  }
  if (/not found|does not exist|\b404\b/.test(lower)) {
    return { ...result, title: 'Not found', message: 'The requested item could not be found.', action: 'Refresh the page and check whether it was removed or renamed.' };
  }
  if (/conflict|duplicate|already exists|already in use|\b409\b/.test(lower)) {
    return { ...result, title: 'Already exists', message: 'This conflicts with an existing item.', action: 'Use a different name or review the existing item.' };
  }
  if (/rate limit|too many requests|\b429\b/.test(lower)) {
    return { ...result, title: 'Too many requests', message: 'The service is temporarily limiting requests.', action: 'Wait a moment, then try again.' };
  }
  if (/timeout|timed out/.test(lower)) {
    return { ...result, title: 'Request timed out', message: `It took too long to ${context}.`, action: 'Check the connection and try again.' };
  }
  if (/failed to fetch|network|connection|econn|enotfound|dns/.test(lower)) {
    return { ...result, title: 'Connection problem', message: 'The service could not be reached.', action: 'Check your connection and confirm the service is running, then retry.' };
  }
  if (/api[_ ]?(key|token)|credential|not configured|configuration|\.env\b/.test(lower)) {
    return { ...result, title: 'Setup required', message: 'A required service has not been configured.', action: 'Ask an administrator to review the service settings.' };
  }
  if (/required|invalid|must |at least|valid url|validation/.test(lower)) {
    return { ...result, title: 'Check the entered information', message: TECHNICAL_PATTERN.test(raw) ? result.message : raw, action: 'Correct the highlighted information and try again.', technicalDetail: TECHNICAL_PATTERN.test(raw) ? raw : '' };
  }
  if (/service unavailable|internal server|bad gateway|\b50[0234]\b/.test(lower)) {
    return { ...result, title: 'Service unavailable', message: 'The service is temporarily unavailable.', action: 'Try again shortly. If it continues, contact an administrator.' };
  }
  if (raw && !TECHNICAL_PATTERN.test(raw) && raw.length <= 220) {
    return { ...result, message: raw, technicalDetail: '' };
  }
  return result;
}

export function friendlyRunMessage(run) {
  const raw = rawMessage(run?.message);
  const issueMatch = raw.match(/(\d+) source\(s\) had fetch issues/i);
  if (issueMatch) {
    const count = Number(issueMatch[1]);
    return `Pipeline complete. ${count} source${count === 1 ? '' : 's'} need attention.`;
  }
  if (run?.status === 'failed') return 'Pipeline did not complete. Open the run to review the issue and suggested action.';
  if (run?.status === 'cancelled') return 'Pipeline was stopped before it completed.';
  if (run?.status === 'success') return 'Pipeline completed successfully.';
  if (run?.status === 'running') return 'Pipeline is currently running.';
  return raw && !TECHNICAL_PATTERN.test(raw) && raw.length <= 160 ? raw : 'Pipeline is waiting to start.';
}
