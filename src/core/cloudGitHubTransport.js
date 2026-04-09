import { requestJson } from './cloudTransport.js';
import { decodeUtf8Base64, encodeUtf8Base64 } from './cloudSyncUtils.js';

export function buildGitHubEndpointUrl({ owner, repo, path }) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedPath = String(path || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/contents/${encodedPath}`;
}

export function buildGitHubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

export async function fetchGitHubSnapshot({ owner, repo, path, token, allowMissing = false } = {}) {
  let response = null;
  const endpoint = buildGitHubEndpointUrl({ owner, repo, path });

  try {
    response = await requestJson(endpoint, {
      method: 'GET',
      headers: buildGitHubHeaders(token),
    });
  } catch (error) {
    if (allowMissing && error?.status === 404) {
      return null;
    }
    throw error;
  }

  if (!response) {
    return null;
  }

  if (response.truncated) {
    throw new Error('雲端檔案太大，GitHub API 回傳 truncated');
  }

  if (typeof response.content !== 'string' || response.encoding !== 'base64') {
    throw new Error('GitHub 回傳的內容格式不正確');
  }

  return {
    sha: typeof response.sha === 'string' ? response.sha : null,
    text: decodeUtf8Base64(response.content),
  };
}

export async function commitGitHubSnapshot({
  owner,
  repo,
  path,
  token,
  branch,
  snapshot,
  remoteSha = null,
}) {
  const endpoint = buildGitHubEndpointUrl({ owner, repo, path });
  const body = {
    message: `NodeNote autosave ${new Date(snapshot.editedAt || snapshot.savedAt || Date.now()).toISOString()}`,
    content: encodeUtf8Base64(JSON.stringify(snapshot, null, 2)),
    branch,
  };

  if (remoteSha) {
    body.sha = remoteSha;
  }

  return requestJson(endpoint, {
    method: 'PUT',
    headers: buildGitHubHeaders(token),
    body: JSON.stringify(body),
  });
}

export async function deleteGitHubSnapshot({
  owner,
  repo,
  path,
  token,
  branch,
}) {
  const endpoint = buildGitHubEndpointUrl({ owner, repo, path });
  const remote = await fetchGitHubSnapshot({
    owner,
    repo,
    path,
    token,
    allowMissing: true,
  });

  if (!remote?.sha) {
    return {
      deleted: false,
      missing: true,
      path,
      branch,
    };
  }

  const body = {
    message: `NodeNote delete snapshot ${new Date().toISOString()}`,
    sha: remote.sha,
    branch,
  };

  return requestJson(endpoint, {
    method: 'DELETE',
    headers: buildGitHubHeaders(token),
    body: JSON.stringify(body),
  });
}
