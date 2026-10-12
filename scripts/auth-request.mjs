// Development-only validation for the external Claude sign-in page.
const failure = (message, code = 'AUTH_ERROR') => Object.assign(new Error(message), { code });

export function validateClaudeAuthorization(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('Claude sign-in URL was denied.'); }
  const required = {
    code: 'true', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', response_type: 'code',
    redirect_uri: 'https://platform.claude.com/oauth/code/callback', code_challenge_method: 'S256',
    scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  };
  if (url.origin !== 'https://claude.ai' || url.pathname !== '/oauth/authorize' || url.username || url.password || url.hash
    || Object.entries(required).some(([key, expected]) => url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== expected)
    || ['state', 'code_challenge'].some(key => url.searchParams.getAll(key).length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get(key)))
    || [...url.searchParams.keys()].some(key => !(key in required) && !['state', 'code_challenge'].includes(key))) {
    throw failure('Claude sign-in URL was denied.');
  }
}
