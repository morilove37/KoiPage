import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { createFolder, folderPath, getFolderMode, removeFolderTree, renameFolder } from './folders';
import type { LibraryFolder } from './folders';
import type { FolderDropProps } from './useFolderDrag';

interface Props {
  folders: LibraryFolder[];
  active: string;
  busy: boolean;
  society: boolean;
  statusMode: boolean;
  onSelect: (id: string) => void;
  onSociety: () => void;
  onStatus: () => void;
  onClassify: () => void;
  onSave: (folders: LibraryFolder[]) => Promise<boolean>;
  canReset:boolean;
  onReset:()=>Promise<boolean>;
  onMove:()=>void;
  dropProps:(id:string)=>FolderDropProps;
}

/** Keep top-level navigation visible while creating children in the current folder. */
export function FolderPanel({ folders, active, busy, society, statusMode, onSelect, onSociety, onStatus, onClassify, onSave, canReset, onReset, onMove, dropProps }: Props) {
  const [editing, setEditing] = useState<{ id?: string; parentId?: string } | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<LibraryFolder | null>(null);
  const [resetting,setResetting]=useState(false);
  const [resetError,setResetError]=useState('');
  const folderRow = useRef<HTMLDivElement>(null);
  const current = society ? undefined : folders.find(folder => folder.id === active);
  const path = current ? folderPath(folders, current.id) : [];
  const contentMode = current ? getFolderMode(folders,current.id) : null;
  const roots = folders.filter(folder => !folder.parentId);
  const openEditor = (id?: string, atRoot = false) => {
    setEditing(id ? {id} : {parentId:atRoot ? undefined : current?.id});
    setName(id ? folders.find(folder => folder.id === id)?.name ?? '' : '');
    setError('');
  };
  const save = async () => {
    if (!editing || busy) return;
    setError('');
    try {
      const next = editing.id ? renameFolder(folders, editing.id, name) : createFolder(folders, name, crypto.randomUUID(), editing.parentId);
      if (await onSave(next)) {
        setEditing(null);
        if (!editing.id) requestAnimationFrame(() => {
          if (folderRow.current) folderRow.current.scrollLeft = folderRow.current.scrollWidth;
        });
      }
      else setError('保存失败，请重试。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="flex flex-col gap-3" aria-label="文件夹导航">
    <div ref={folderRow} className="flex items-center gap-2 overflow-x-auto border-b border-border pb-3" aria-label="当前层级文件夹">
      {current?.parentId ? <Button variant="outline" onClick={() => onSelect(current.parentId!)}>← 返回上级</Button> : null}
      <Button variant={society ? 'default' : 'outline'} aria-pressed={society} onClick={onSociety}>按社团分类</Button>
      <Button variant={statusMode ? 'default' : 'outline'} aria-pressed={statusMode} onClick={onStatus}>游玩状态</Button>
      {roots.map(folder => <Button {...dropProps(folder.id)} key={folder.id} variant={path[0]?.id === folder.id ? 'default' : 'outline'} aria-pressed={path[0]?.id === folder.id} className="folder-drop-target max-w-48" title={folder.name} onClick={() => onSelect(folder.id)}>
        <span className="truncate">{folder.name}</span>
      </Button>)}
      <Button variant="outline" disabled={busy} aria-label="自定义文件夹" onClick={() => openEditor(undefined, true)}>＋ 自定义文件夹</Button>
      {current ? <div className="ml-auto flex shrink-0 gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => openEditor(current.id)}>重命名</Button>
        <Button variant="ghost" disabled={busy} onClick={onMove}>移动文件夹</Button>
        {contentMode && canReset ? <Button variant="ghost" disabled={busy} onClick={() => {setResetError('');setResetting(true);}}>重新选择类型</Button> : null}
        <Button variant="ghost" disabled={busy} onClick={() => {setDeleting(current);setError('');}}>删除文件夹</Button>
      </div> : null}
    </div>
    {current ? <div className="flex flex-wrap items-center gap-2" aria-label="文件夹操作">
      {contentMode !== 'games' && contentMode !== 'mixed' ? <Button disabled={busy} title={`在${current.name}中创建子文件夹`} onClick={() => openEditor()}>创建子文件夹</Button> : null}
      {contentMode !== 'folders' ? <Button variant="outline" disabled={busy} onClick={onClassify}>{contentMode === 'games' || contentMode === 'mixed' ? '管理游戏' : '直接添加游戏'}</Button> : null}
    </div> : null}
    <Dialog open={editing !== null} onClose={() => { if (!busy) setEditing(null); }} title={editing?.id ? '重命名文件夹' : editing?.parentId ? '创建子文件夹' : '创建文件夹'}
      description={!editing?.id ? editing?.parentId ? `创建位置：${folderPath(folders, editing.parentId).map(folder => folder.name).join(' / ')}` : '创建位置：顶层文件夹' : undefined}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setEditing(null)}>取消</Button><Button disabled={busy || !name.trim()} onClick={() => void save()}>保存</Button></>}>
      <form onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) void save(); }}>
        <Input autoFocus aria-label="文件夹名称" placeholder="输入文件夹名称" maxLength={40} value={name} onChange={event => setName(event.target.value)} disabled={busy} />
        {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      </form>
    </Dialog>
    <ConfirmDialog open={deleting !== null} title={`删除文件夹「${deleting?.name ?? ''}」？`}
      description={<span>将删除此文件夹及其全部子文件夹的分类关系，游戏记录和磁盘文件都会保留。{error ? <span role="alert" className="mt-2 block text-destructive">{error}</span> : null}</span>}
      busy={busy} destructive onCancel={() => {if (!busy) setDeleting(null);}} onConfirm={() => {
        if (!deleting || busy) return;
        void (async () => {
          if (await onSave(removeFolderTree(folders, deleting.id))) {
            if (deleting.parentId) onSelect(deleting.parentId); else onSociety();
            setDeleting(null);
          } else setError('删除失败，请重试。');
        })();
      }} />
    <ConfirmDialog open={resetting} title="重新选择文件夹类型？" busy={busy} description={<span>当前文件夹为空，将重新显示「创建子文件夹」和「直接添加游戏」两个选项。{resetError?<span role="alert" className="mt-2 block text-destructive">{resetError}</span>:null}</span>}
      confirmText="重新选择" onCancel={()=>{if(!busy)setResetting(false);}} onConfirm={()=>{void(async()=>{try{if(await onReset())setResetting(false);else setResetError('保存失败，请重试。');}catch(cause){setResetError(cause instanceof Error?cause.message:String(cause));}})();}} />
  </div>;
}
