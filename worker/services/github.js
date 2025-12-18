const GH_API = "https://api.github.com";

function b64encodeUtf8(str) {
  try {
    const latin1String = unescape(encodeURIComponent(str));
    return btoa(latin1String);
  } catch (e) {
    console.error("b64encodeUtf8 failed for part of string:", e);
    const safeStr = str.replace(/[^\x00-\xFF]/g, '?');
    try { return btoa(safeStr); }
    catch (e2) { console.error("btoa fallback failed:", e2); throw new Error("btoa failed even on fallback."); }
  }
}

function b64decodeUtf8(b64) { try { return decodeURIComponent(escape(atob(b64))); } catch { return atob(b64); } }

function ghHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "imap-sales-worker/1.8",
  };
}

export async function ghGetFile(env, path, branch) {
  const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch || env.GH_BRANCH)}`;
  const r = await fetch(url, { headers: ghHeaders(env) });
  if (r.status === 404) return { items: [], sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const raw = (data.content || "").replace(/\n/g, "");
  const content = raw ? b64decodeUtf8(raw) : "[]";
  let items = [];
  try { items = content.trim() ? JSON.parse(content) : []; if (!Array.isArray(items)) items = []; }
  catch (e) { console.error("Failed to parse JSON from GitHub:", content); throw new Error(`Failed to parse JSON from ${path}: ${e.message}`); }
  return { items, sha: data.sha };
}

export async function ghPutFile(env, path, items, sha, message, branch) {
  const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}`;
  const body = { message: message || `update ${path}`, content: b64encodeUtf8(JSON.stringify(items, null, 2)), branch: branch || env.GH_BRANCH, ...(sha ? { sha } : {}), };
  const r = await fetch(url, { method: "PUT", headers: { ...ghHeaders(env), "Content-Type": "application/json" }, body: JSON.stringify(body), });
  if (!r.ok) throw new Error(`GitHub PUT ${path} failed (${r.status}): ${await r.text()}`);
  return r.json();
}

export async function ghGetContent(env, path) {
  const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(env.GH_BRANCH)}`;
  const r = await fetch(url, { headers: ghHeaders(env) });
  if (r.status === 404) return { content: "", sha: null };
  if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const raw = (data.content || "").replace(/\n/g, "");
  return { content: raw ? b64decodeUtf8(raw) : "", sha: data.sha };
}

export async function ghPutContent(env, path, content, sha, message) {
  const url = `${GH_API}/repos/${env.GH_REPO}/contents/${encodeURIComponent(path)}`;
  const body = { message: message || `update ${path}`, content: b64encodeUtf8(content), branch: env.GH_BRANCH, ...(sha ? { sha } : {}), };
  const r = await fetch(url, { method: "PUT", headers: { ...ghHeaders(env), "Content-Type": "application/json" }, body: JSON.stringify(body), });
  if (!r.ok) throw new Error(`GitHub PUT ${path} failed (${r.status}): ${await r.text()}`);
  return r.json();
}

export function parseGitHubRepo(repo) {
  if (!repo || typeof repo !== 'string') return null;
  const parts = repo.trim().split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], name: parts[1] };
}

export async function ghGraphql(env, query, variables) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new Error('GitHub token missing for GraphQL request');
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      ...ghHeaders(env),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.errors?.map(err => err?.message).filter(Boolean).join('; ') || `${response.status}`;
    throw new Error(`GitHub GraphQL error (${message})`);
  }
  if (json?.errors?.length) {
    const message = json.errors.map(err => err?.message).filter(Boolean).join('; ');
    throw new Error(`GitHub GraphQL error (${message || 'unknown'})`);
  }
  return json?.data;
}
