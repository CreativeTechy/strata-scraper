import { apiErrorFromResponse } from '../errors/apiError.js';

async function request(projectId, suffix, options = {}) {
  const response = await fetch(`/api/projects/${projectId}/articles${suffix}`, {
    credentials: 'include', ...options,
  });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json();
}

export const getProjectArticleRemovalPreview = (projectId, signal) =>
  request(projectId, '/removal-preview', { signal });
export const removeProjectArticles = (projectId, confirm) =>
  request(projectId, '', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }) });
