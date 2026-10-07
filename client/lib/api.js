const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

let sessionPromise = null;

export class AuthenticationError extends Error {}

function sessionExpired() {
  sessionPromise = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('open-dots:authentication-required'));
  }
}

export async function ensureSession() {
  if (typeof window === 'undefined') return null;
  if (!sessionPromise) {
    sessionPromise = fetch(`${API_BASE_URL}/auth/session`, {
      credentials: 'include',
    })
      .then((res) => {
        if (res.status === 401) throw new AuthenticationError('Sign in to Open Dots.');
        if (!res.ok) throw new Error('Could not reach the authentication service.');
        return res.json();
      })
      .catch((err) => {
        sessionPromise = null;
        throw err;
      });
  }
  return sessionPromise;
}

async function apiFetch(url, options = {}) {
  try {
    await ensureSession();
  } catch (error) {
    if (error instanceof AuthenticationError) sessionExpired();
    throw error;
  }
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
  });
  if (response.status === 401) {
    sessionExpired();
    throw new AuthenticationError('Your session expired. Sign in again.');
  }
  return response;
}

export async function login(token) {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  });
  if (response.status === 401) throw new AuthenticationError('The owner token is incorrect.');
  if (!response.ok) throw new Error('Sign-in failed. Check the API connection and allowed origins.');
  const session = await response.json();
  sessionPromise = Promise.resolve(session);
  return session;
}

export async function logout() {
  const response = await fetch(`${API_BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
  if (!response.ok) throw new Error('Could not sign out. Reconnect to the API and retry.');
  sessionExpired();
}

export async function fetchBots() {
  try {
    const res = await apiFetch(`${API_BASE_URL}/bots`);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.warn('Backend server offline or unreachable:', err);
    return [];
  }
}

export async function createBot(botData) {
  const res = await apiFetch(`${API_BASE_URL}/bots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(botData),
  });
  if (!res.ok) throw new Error('Failed to create bot');
  return res.json();
}

export async function updateBot(botId, updates) {
  const res = await apiFetch(`${API_BASE_URL}/bots/${botId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error('Failed to update bot');
  return res.json();
}

export async function deleteBot(botId) {
  const res = await apiFetch(`${API_BASE_URL}/bots/${botId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete bot');
  return res.json();
}

export async function fetchModels() {
  try {
    const res = await apiFetch(`${API_BASE_URL}/models`);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.warn('Models catalog API offline:', err);
    return [];
  }
}

export async function fetchChatHistory(threadId) {
  try {
    const res = await apiFetch(`${API_BASE_URL}/chat/history/${threadId}`);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.warn('Chat history API offline:', err);
    return [];
  }
}

export async function sendMessage(threadId, botId, text, model = 'gpt-5-mini', imageUrl = null) {
  try {
    const res = await apiFetch(`${API_BASE_URL}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thread_id: threadId,
        bot_id: botId,
        user_text: text,
        model,
        image_url: imageUrl,
      }),
    });
    if (!res.ok) throw new Error('Failed to send message');
    return await res.json();
  } catch (err) {
    console.warn('Send message API call error:', err);
    return { status: 'error', detail: err.message };
  }
}

export async function uploadImage(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await apiFetch(`${API_BASE_URL}/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Failed to upload image' }));
    throw new Error(err.detail || 'Failed to upload image');
  }
  return res.json();
}

export async function fetchConnectorCatalog() {
  return connectorRequest('/catalog');
}

export async function fetchConnectionStatus(slugs = []) {
  if (!slugs.length) return { services: {} };
  return connectorRequest(`?services=${encodeURIComponent(slugs.join(','))}`);
}

export async function authorizeConnector(slug) {
  return connectorRequest(`/${encodeURIComponent(slug)}/authorize`, { method: 'POST' });
}

export async function disconnectConnector(slug) {
  return connectorRequest(`/${encodeURIComponent(slug)}`, { method: 'DELETE' });
}

async function connectorRequest(path, options = {}) {
  const response = await apiFetch(`${API_BASE_URL}/connectors${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : typeof data.error === 'string' ? data.error : 'No se pudo completar la acción. Revisa los datos e inténtalo de nuevo.');
  return data;
}

export const configureConnectors = (apiKey) => connectorRequest('/setup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: apiKey }),
});
export const fetchYouTubeChannel = () => connectorRequest('/youtube/channel');
export const fetchConnectorActions = (slug, query = '', cursor = '') => connectorRequest(`/${encodeURIComponent(slug)}/actions?query=${encodeURIComponent(query)}&cursor=${encodeURIComponent(cursor)}`);
export const fetchYouTubeUploads = () => connectorRequest('/youtube/uploads');
export function prepareYouTubeVideo(file, metadata) {
  const data = new FormData();
  data.append('file', file);
  data.append('metadata', JSON.stringify(metadata));
  return connectorRequest('/youtube/uploads', { method: 'POST', body: data });
}
export const publishYouTubeVideo = (id) => connectorRequest(`/youtube/uploads/${encodeURIComponent(id)}/publish`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
});
export const discardYouTubeVideo = (id) => connectorRequest(`/youtube/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });

async function teamRequest(path, options = {}) {
  const response = await apiFetch(`${API_BASE_URL}/team${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'No se pudo completar la tarea del equipo.');
  return data;
}
export const fetchTeamRuns = () => teamRequest('/runs');
export const fetchTeamRun = (id) => teamRequest(`/runs/${encodeURIComponent(id)}`);
export const createTeamRun = (data) => teamRequest('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
export const cancelTeamRun = (id) => teamRequest(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });

export async function fetchPersistence() {
  const response = await apiFetch(`${API_BASE_URL}/persistence/status`);
  const data = await response.json();
  if (!response.ok) throw new Error('No se pudo consultar el guardado de datos.');
  return data;
}
export async function syncPersistence() {
  const response = await apiFetch(`${API_BASE_URL}/persistence/sync`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || 'No se pudo guardar la copia.');
  return data;
}
export async function downloadPersistence() {
  const response = await apiFetch(`${API_BASE_URL}/persistence/download`);
  if (!response.ok) { const data = await response.json(); throw new Error(data.detail || 'No se pudo descargar la copia.'); }
  return response.blob();
}

export async function fetchAuditEvents(limit = 100) {
  try {
    const res = await apiFetch(`${API_BASE_URL}/audit?limit=${encodeURIComponent(limit)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.warn('Audit API offline:', err);
    return [];
  }
}

export function subscribeToChatStream(threadId, model, onEvent, onError) {
  const url = `${API_BASE_URL}/chat/stream/${threadId}?model=${encodeURIComponent(model)}`;
  let eventSource = null;
  let cancelled = false;

  ensureSession()
    .then(() => {
      if (cancelled) return;
      eventSource = new EventSource(url, { withCredentials: true });

      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (onEvent) onEvent(data);
          if (data.type === 'turn.completed') eventSource.close();
        } catch (err) {
          console.warn('Failed to parse SSE payload:', err);
        }
      };

      eventSource.onerror = (err) => {
        // Gracefully close stream when completed or disconnected
        if (eventSource) {
          eventSource.close();
        }
        if (onError && typeof onError === 'function') {
          onError(err);
        }
        sessionPromise = null;
        ensureSession().catch((error) => {
          if (error instanceof AuthenticationError) sessionExpired();
        });
      };
    })
    .catch((err) => {
      console.warn('Authentication or EventSource initialization error:', err);
      if (onError && typeof onError === 'function') {
        onError(err);
      }
    });

  return () => {
    cancelled = true;
    if (eventSource) {
      eventSource.close();
    }
  };
}

export async function respondApproval(requestId, action) {
  const res = await apiFetch(`${API_BASE_URL}/approvals/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, action }),
  });
  if (!res.ok) throw new Error('Failed to respond approval');
  return res.json();
}

export async function fetchSettings() {
  try {
    const res = await apiFetch(`${API_BASE_URL}/settings`);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn('Fetch settings API offline:', err);
    return null;
  }
}

export async function saveSettings(settingsData) {
  const res = await apiFetch(`${API_BASE_URL}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settingsData),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    const detail = Array.isArray(error.detail)
      ? error.detail.map((item) => item.msg).join(' ')
      : error.detail;
    throw new Error(detail || 'Failed to save settings');
  }
  return res.json();
}

export async function agentState(path, method = 'GET', body) {
  const response = await apiFetch(`${API_BASE_URL}/${path}`, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((e) => e.msg).join(' ') : data.detail;
    throw new Error(detail || 'No se pudo completar la operación.');
  }
  return data;
}

export async function fetchComputerStatus(botId) {
  const res = await apiFetch(`${API_BASE_URL}/computers/${encodeURIComponent(botId)}`);
  if (!res.ok) throw new Error('Failed to load computer status');
  return res.json();
}

export async function fetchComputerHealth(botId) {
  const res = await apiFetch(`${API_BASE_URL}/computers/${encodeURIComponent(botId)}/health`);
  if (!res.ok) throw new Error('Failed to load computer health');
  return res.json();
}

export async function fetchComputerScreenshot(botId) {
  const res = await apiFetch(`${API_BASE_URL}/computers/${encodeURIComponent(botId)}/screenshot`);
  if (!res.ok) throw new Error('Failed to load computer screen state');
  return res.json();
}

async function runComputerLifecycleAction(botId, action) {
  const res = await apiFetch(`${API_BASE_URL}/computers/${encodeURIComponent(botId)}/${action}`, {
    method: 'POST',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.detail || `Computer ${action} failed`);
  }
  return res.json();
}

export function createComputer(botId) {
  return runComputerLifecycleAction(botId, 'create');
}

export function startComputer(botId) {
  return runComputerLifecycleAction(botId, 'start');
}

export function pauseComputer(botId) {
  return runComputerLifecycleAction(botId, 'pause');
}

export function stopComputer(botId) {
  return runComputerLifecycleAction(botId, 'stop');
}

export function resetComputer(botId) {
  return runComputerLifecycleAction(botId, 'reset');
}

export async function runComputerAction(botId, action, argumentsData = {}) {
  const res = await apiFetch(`${API_BASE_URL}/computers/${encodeURIComponent(botId)}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, arguments: argumentsData }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    throw new Error(payload.detail || 'Computer action failed');
  }
  return payload;
}

export async function executeComputerAction(botId, requestId) {
  const res = await apiFetch(
    `${API_BASE_URL}/computers/${encodeURIComponent(botId)}/actions/${encodeURIComponent(requestId)}/execute`,
    { method: 'POST' },
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.detail || 'Computer action execution failed');
  return payload;
}
