import { isSupabaseConfigured } from './supabase';
import { SupabaseApiError, supabaseRequest } from './supabaseService';

let memoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  memoryToken = token;
}

export function getAuthToken(): string | null {
  return memoryToken;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  if (isSupabaseConfigured && url.startsWith('/api/') && !url.startsWith('/api/supabase/')) {
    try {
      return await supabaseRequest<T>(url, options);
    } catch (err) {
      if (err instanceof SupabaseApiError) {
        throw new ApiError(err.message, err.status);
      }
      throw new ApiError(err instanceof Error ? err.message : 'Request failed', 400);
    }
  }

  const headers = new Headers(options.headers || {});
  headers.set('X-Requested-With', 'XMLHttpRequest');
  if (memoryToken) {
    headers.set('Authorization', `Bearer ${memoryToken}`);
  }
  if (!(options.body instanceof FormData) && !headers.has('Content-Type') && options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      // ignore json parse failure
    }
    throw new ApiError(msg, res.status);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}
