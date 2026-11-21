// In-memory operator Bearer token (never written to localStorage or sessionStorage)
let operatorSessionToken: string | null = null;

export function setOperatorToken(token: string | null): void {
  operatorSessionToken = token;
}

export function getOperatorToken(): string | null {
  return operatorSessionToken;
}

export async function apiFetch(
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (operatorSessionToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${operatorSessionToken}`);
  }
  return fetch(input, {
    ...init,
    headers,
  });
}
