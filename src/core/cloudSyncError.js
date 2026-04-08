export function resolveCloudSyncErrorMessage(error, provider = 'github') {
  if (!error) {
    return '未知錯誤';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error.status === 401 || error.status === 403) {
    if (provider === 'sheets') {
      return 'Google Sheet Web App 權限不足或 Secret 錯誤';
    }
    return 'GitHub Token 無效或沒有 Contents: write 權限';
  }

  if (error.status === 404) {
    if (provider === 'sheets') {
      return '找不到指定的 Google Sheet Web App URL';
    }
    return '找不到指定的 Repo / Branch / Path';
  }

  return error.message || '同步失敗';
}
