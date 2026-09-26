export function downloadBackup(payload, fileName = 'Kalo_Backup.json') {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function readBackupFile(file) {
  if (!file) throw new Error('Chưa chọn file backup.');
  if (file.size > 10 * 1024 * 1024) throw new Error('File backup quá lớn.');
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('File backup không phải JSON hợp lệ.'); }
  if (!data || data.app !== 'Kalo' || Number(data.version || 0) < 1) {
    throw new Error('Đây không phải file backup Kalo hợp lệ.');
  }
  return data;
}
