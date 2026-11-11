import {useState} from 'react';
import {writeText} from '@tauri-apps/plugin-clipboard-manager';
import {Dialog} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {isTauri} from '@tauri-apps/api/core';
import {LEGAL_DOCUMENTS} from './documents';
import type {LegalDocumentId} from './documents';
import {POLICY} from './consent';

const ALL_DOCUMENTS: LegalDocumentId[] = ['privacy', 'terms', 'crossBorder', 'thirdParties'];

/** Only trusted bundled text is rendered; no HTML interpretation or remote fetch. */
export function LegalContent({content}: {content: string}) {
  return <div className="space-y-4 break-words text-sm leading-7">
    {content.trim().split(/\r?\n\s*\r?\n/).map((block, index) => {
      if (/^# /.test(block)) return null;
      if (/^## /.test(block)) return <h3 key={index} className="pt-2 font-semibold text-foreground">{block.slice(3)}</h3>;
      if (/^- /.test(block)) return <ul key={index} className="list-disc space-y-2 pl-5 text-muted-foreground">{block.split(/\r?\n/).map((line, item) => <li key={item}>{line.replace(/^- /, '')}</li>)}</ul>;
      return <p key={index} className="whitespace-pre-line text-muted-foreground">{block}</p>;
    })}
  </div>;
}

export function LegalDocuments({ids = ALL_DOCUMENTS}: {ids?: LegalDocumentId[]}) {
  const [selected, setSelected] = useState<LegalDocumentId | null>(null);
  const [message, setMessage] = useState('');
  const [copying, setCopying] = useState(false);
  const document = selected ? LEGAL_DOCUMENTS[selected] : null;
  async function copy() {
    if (!document || copying) return;
    setCopying(true);
    try {
      if (isTauri()) await writeText(document.content);
      else await navigator.clipboard.writeText(document.content);
      setMessage('全文已复制，可粘贴到文本文件保存。');
    } catch { setMessage('复制未完成，请选中文字后手动复制。'); }
    finally { setCopying(false); }
  }
  return <>
    <div className="flex flex-wrap gap-x-3 gap-y-2 text-xs" aria-label="协议与隐私文档">
      {ids.map(id => <button key={id} type="button" className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {setMessage('');setSelected(id);}}>{LEGAL_DOCUMENTS[id].title}</button>)}
    </div>
    <Dialog open={Boolean(document)} onClose={() => setSelected(null)} title={document?.title}
      description={`版本 ${POLICY.version} · ${POLICY.effectiveDate} · 全文可离线阅读`}
      className="max-w-3xl" footer={<>
        {message ? <p role="status" className="mr-auto text-xs text-muted-foreground">{message}</p> : null}
        <Button variant="outline" disabled={copying} onClick={() => void copy()}>复制全文</Button>
        <Button onClick={() => setSelected(null)}>关闭</Button>
      </>}>
      {document ? <div key={selected} tabIndex={0} aria-label={`${document.title}全文`}><LegalContent content={document.content}/></div> : null}
    </Dialog>
  </>;
}
