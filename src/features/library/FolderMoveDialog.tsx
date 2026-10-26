import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { LabeledSelect } from '@/components/ui/select';
import { folderPath, getFolderMode } from './folders';
import type { LibraryFolder } from './folders';

export function FolderMoveDialog({ folders, folderId, busy, onClose, onMove }: {
  folders: LibraryFolder[];
  folderId: string;
  busy: boolean;
  onClose: () => void;
  onMove: (parentId: string | undefined, beforeId: string | undefined) => Promise<boolean>;
}) {
  const source = folders.find(folder => folder.id === folderId);
  const [destination, setDestination] = useState(source?.parentId ?? '__root__');
  const [beforeId, setBeforeId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const parentId = destination === '__root__' ? undefined : destination;
  const pathLabel = (id: string) => folderPath(folders, id).map(folder => folder.name).join(' / ');
  const destinations = folders.filter(folder => {
    const mode = getFolderMode(folders, folder.id);
    return (mode === null || mode === 'folders' || folder.id === source?.parentId) && !folderPath(folders, folder.id).some(item => item.id === folderId);
  });
  const siblings = folders.filter(folder => folder.parentId === parentId && folder.id !== folderId);
  const move = async () => {
    if (locked || !source) return;
    setError('');
    setSaving(true);
    try {
      if (await onMove(parentId, beforeId || undefined)) onClose();
      else setError('移动失败，请重试。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移动失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open title="移动文件夹" description={source ? `移动「${pathLabel(source.id)}」，子文件夹和游戏归类会一同保留。` : '文件夹不存在，请关闭后重试。'}
    onClose={() => { if (!locked) onClose(); }}
    footer={<><Button variant="outline" disabled={locked} onClick={onClose}>取消</Button><Button disabled={locked || !source} onClick={() => void move()}>{saving ? '移动中…' : '移动'}</Button></>}>
    <div className="flex flex-col gap-3">
      <LabeledSelect label="目标位置" value={destination} disabled={locked} onValueChange={value => {
        setDestination(value);
        setBeforeId('');
        setError('');
      }} options={[{ value: '__root__', label: '顶层文件夹' }, ...destinations.map(folder => ({ value: folder.id, label: pathLabel(folder.id) }))]} />
      <LabeledSelect label="放置位置" value={beforeId} disabled={locked} onValueChange={setBeforeId}
        options={[{ value: '', label: '放在末尾' }, ...siblings.map(folder => ({ value: folder.id, label: `放在「${pathLabel(folder.id)}」之前` }))]} />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  </Dialog>;
}
