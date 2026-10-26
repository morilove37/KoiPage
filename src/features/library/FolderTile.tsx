import { GeometryIcon } from '@/components/ui/geometry-icon';
import type { FolderDropProps } from './useFolderDrag';

export function FolderTile({ name, count, description, onClick, interaction }: { name: string; count: number; description?: string; onClick: () => void; interaction?:FolderDropProps }) {
  return <button {...interaction} type="button" title={name} onClick={onClick}
    className="folder-drop-target flex min-w-0 flex-col items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-accent">
    <GeometryIcon name="folder" className="size-8 text-primary" />
    <span className="w-full truncate font-medium">{name}</span>
    <span className="text-xs text-muted-foreground">{description ?? `${count} 部游戏`}</span>
  </button>;
}
