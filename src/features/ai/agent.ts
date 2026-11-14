/** Pure, testable agent protocol. Never dispatch model-supplied IPC names. */
import type { TokenUsage } from './pricing';
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Message { role: 'user' | 'assistant' | 'tool'; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; usage?: TokenUsage }
export interface AgentEvent { kind: 'text' | 'tool' | 'thinking' | 'usage'; text: string; ok?: boolean; name?: string; detail?: string; usage?: TokenUsage }
class ToolInputError extends Error {}
/** 给操作记录补充具体游戏名，便于用户核对；只读取工具结果里的标题或搜索词。 */
function toolDetail(name: string, args: Record<string, unknown>, result: unknown): string | undefined {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (name === 'list_games') {
    const search = typeof args.search === 'string' ? args.search.trim() : '';
    if (search) return `搜索「${search.slice(0, 40)}」`;
    return typeof record.total === 'number' ? `${record.total} 部游戏` : undefined;
  }
  if (name === 'get_stats') return undefined;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  return title ? title.slice(0, 40) : undefined;
}
export function launchChecked(controller: { start: (id: number, before: () => Promise<boolean>) => Promise<{ kind: string }> }, id: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return controller.start(id, async () => !signal.aborted);
}
const statuses = ['unplayed', 'wishlist', 'playing', 'completed', 'on_hold', 'dropped'];
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
const idSchema = { type: 'integer', description: '必须使用本轮 list_games 返回的游戏 ID' };
export const TOOLS = [
  tool('list_games', '搜索游戏库。修改、打开、启动之前必须先查询目标。返回有限页，可用 nextOffset 继续。', {
    search: { type: 'string' }, status: { type: 'string', enum: statuses }, favoriteOnly: { type: 'boolean' },
    sort: { type: 'string', enum: ['title', 'rating', 'playTimeSeconds', 'lastPlayedAt'] },
    limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0 },
  }),
  tool('get_game', '读取游戏资料、简介和标签。简介每页最多8000字符；nextDescriptionOffset非空时按该偏移继续读取，直到descriptionComplete=true，再翻译或改写完整简介。', {
    id: idSchema, descriptionOffset: { type: 'integer', minimum: 0, description: '首次从0开始，后续使用nextDescriptionOffset顺序读取' },
  }, ['id']),
  tool('get_stats', '读取游戏库数量、状态分布、收藏数和总游玩时长。', {}),
  tool('update_game', '按用户明确要求直接保存游戏资料，包括翻译后替换简介，无需额外确认。只传需要修改的字段。替换非空简介前须get_game完整读取原文，不得将片段当作全文；只修改用户指定内容。标签仅追加。', {
    id: idSchema, status: { type: 'string', enum: statuses }, favorite: { type: 'boolean' },
    title: { type: 'string', minLength: 1, maxLength: 500 },
    originalTitle: { type: ['string', 'null'], maxLength: 500 },
    developer: { type: ['string', 'null'], maxLength: 500 },
    releaseDate: { type: ['string', 'null'], description: 'YYYY-MM-DD格式的有效日期，null清空' },
    rating: { type: ['number', 'null'], minimum: 0, maximum: 10 },
    description: { type: ['string', 'null'], maxLength: 30000, description: '完整的新简介，保留段落；用户明确要求翻译并替换时直接保存，null清空' },
    addTags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
  }, ['id']),
  tool('open_game', '在软件中打开已查询游戏的详情页面。', { id: idSchema }, ['id']),
  tool('launch_game', '启动已查询游戏，软件会要求用户确认。不要在用户拒绝后重试。', { id: idSchema }, ['id']),
];

type GameData = { id: number; title: string; [key: string]: unknown };
export interface ToolDependencies {
  list: (filter: { search?: string; status?: string; favoriteOnly?: boolean }) => Promise<GameData[]>;
  get: (id: number) => Promise<GameData>;
  tags: () => Promise<Array<{ id: number; name: string }>>;
  stats: () => Promise<unknown>;
  update: (id: number, patch: Record<string, unknown>) => Promise<unknown>;
  open: (id: number) => Promise<void>;
  launch: (id: number) => Promise<{ kind: string }>;
  confirmLaunch: (title: string) => Promise<boolean>;
  changed: () => void;
}
function project(game: GameData) {
  const result: Record<string, unknown> = {};
  for (const key of ['id', 'title', 'originalTitle', 'developer', 'releaseDate', 'status', 'rating', 'favorite', 'playTimeSeconds', 'lastPlayedAt']) {
    if (game[key] !== undefined) result[key] = game[key];
  }
  return result;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ToolInputError(`${name} 参数无效`);
  return value;
}
export function createToolExecutor(deps: ToolDependencies, signal?: AbortSignal) {
  const known = new Set<number>();
  const descriptionReads = new Map<number, { source: string; until: number }>();
  return async (call: ToolCall): Promise<Record<string, unknown>> => {
    signal?.throwIfAborted();
    const definition = TOOLS.find(t => t.function.name === call.function.name);
    if (!definition) throw new ToolInputError('不支持这个操作');
    const args: Record<string, unknown> = JSON.parse(call.function.arguments);
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new ToolInputError('工具参数必须为对象');
    for (const key of Object.keys(args)) if (!(key in definition.function.parameters.properties)) throw new ToolInputError(`不支持的参数：${key}`);
    for (const key of definition.function.parameters.required) if (!(key in args)) throw new ToolInputError(`缺少参数：${key}`);
    const name = call.function.name;
    if ('status' in args && !statuses.includes(args.status as string)) throw new ToolInputError('游戏状态无效');
    if (name === 'list_games') {
      if ('search' in args && (typeof args.search !== 'string' || args.search.length > 200)) throw new ToolInputError('搜索关键词无效');
      if ('favoriteOnly' in args && typeof args.favoriteOnly !== 'boolean') throw new ToolInputError('收藏筛选无效');
      const sort = args.sort ?? 'title';
      if (!['title', 'rating', 'playTimeSeconds', 'lastPlayedAt'].includes(sort as string)) throw new ToolInputError('排序字段无效');
      const limit = integer(args.limit ?? 30, 'limit', 1, 50);
      const offset = integer(args.offset ?? 0, 'offset', 0, 1000000);
      const games = await deps.list({ search: args.search as string | undefined, status: args.status as string | undefined, favoriteOnly: args.favoriteOnly as boolean | undefined });
      games.sort((a, b) => {
        if (sort === 'title') return String(a.title).localeCompare(String(b.title));
        if (sort === 'lastPlayedAt') return String(b.lastPlayedAt ?? '').localeCompare(String(a.lastPlayedAt ?? ''));
        return Number(b[sort as string] ?? -1) - Number(a[sort as string] ?? -1) || a.id - b.id;
      });
      const page = games.slice(offset, offset + limit);
      for (const g of page) known.add(g.id);
      return { total: games.length, games: page.map(project), nextOffset: offset + limit < games.length ? offset + limit : null };
    }
    if (name === 'get_stats') return { stats: await deps.stats() };
    const id = integer(args.id, 'id', 1, Number.MAX_SAFE_INTEGER);
    if (!known.has(id)) throw new ToolInputError('请先查询游戏，使用查询结果中的 ID');
    const game = await deps.get(id);
    signal?.throwIfAborted();
    if (name === 'get_game') {
      const description = String(game.description ?? '');
      const offset = integer(args.descriptionOffset ?? 0, 'descriptionOffset', 0, description.length);
      const previous = descriptionReads.get(id);
      if (offset > 0 && (!previous || previous.source !== description || offset > previous.until)) {
        throw new ToolInputError('简介尚未顺序读取或已改变，请从descriptionOffset=0重新读取');
      }
      const end = Math.min(description.length, offset + 8000);
      const tags = await deps.tags();
      signal?.throwIfAborted();
      const until = offset === 0 ? end : Math.max(previous!.until, end);
      descriptionReads.set(id, { source: description, until });
      return { ...project(game), description: description.slice(offset, end), descriptionOffset: offset,
        descriptionLength: description.length, nextDescriptionOffset: end < description.length ? end : null,
        descriptionComplete: until >= description.length,
        tags: tags.filter(t => Array.isArray(game.tags) && game.tags.includes(t.id)).map(t => t.name) };
    }
    if (name === 'update_game') {
      const patch: Record<string, unknown> = {};
      for (const field of ['title', 'originalTitle', 'developer', 'releaseDate', 'description']) {
        if (!(field in args)) continue;
        const value = args[field];
        if (value === null && field !== 'title') { patch[field] = null; continue; }
        const max = field === 'description' ? 30000 : 500;
        if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new ToolInputError(`${field} 内容无效或超过 ${max} 字符`);
        if (field !== 'description' && /[\r\n\t]/.test(value)) throw new ToolInputError(`${field} 不能包含换行或制表符`);
        if (field === 'title' && !value.trim()) throw new ToolInputError('游戏标题不能为空');
        if (field === 'releaseDate' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) {
          throw new ToolInputError('发售日期必须为有效的 YYYY-MM-DD 日期，清空请传 null');
        }
        patch[field] = field === 'description' ? value : value.trim();
      }
      if ('rating' in args) {
        const rating = args.rating;
        if (rating !== null && (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 10)) throw new ToolInputError('评分必须为0到10之间的数字，清空请传null');
        patch.rating = rating;
      }
      if ('description' in patch && String(game.description ?? '').length > 0) {
        const read = descriptionReads.get(id);
        if (!read || read.source !== game.description) throw new ToolInputError('请重新读取当前完整简介后再替换');
        if (read.until < read.source.length) throw new ToolInputError('请先使用get_game顺序读取完整简介，再保存完整译文或改写内容');
      }
      if ('status' in args) patch.status = args.status;
      if ('favorite' in args) {
        if (typeof args.favorite !== 'boolean') throw new ToolInputError('收藏参数无效');
        patch.favorite = args.favorite ? 1 : 0;
      }
      if ('addTags' in args) {
        if (!Array.isArray(args.addTags) || args.addTags.length > 20 || args.addTags.some(t => typeof t !== 'string' || !t.trim() || t.length > 80)) throw new ToolInputError('标签参数无效');
        if (args.addTags.length) patch.tagNames = [...new Set(args.addTags.map(t => (t as string).trim()))];
      }
      if (!Object.keys(patch).length) throw new ToolInputError('没有需要修改的内容');
      signal?.throwIfAborted();
      await deps.update(id, patch);
      if ('description' in patch) descriptionReads.delete(id);
      deps.changed();
      const changes = { ...patch };
      if (typeof changes.description === 'string') changes.description = { characters: changes.description.length, preview: changes.description.slice(0, 200) };
      return { updated: true, id, title: patch.title ?? game.title, changes };
    }
    if (name === 'open_game') { await deps.open(id); return { opened: true, id, title: game.title }; }
    if (!(await deps.confirmLaunch(game.title))) return { cancelled: true, id, title: game.title };
    signal?.throwIfAborted();
    const result = await deps.launch(id);
    return { id, title: game.title, started: result.kind === 'started', state: result.kind };
  };
}

export async function runAgent(options: {
  history: Message[]; signal: AbortSignal;
  request: (messages: Message[]) => Promise<Message>;
  execute: (call: ToolCall) => Promise<unknown>;
  onEvent: (event: AgentEvent) => void;
}) {
  const { history, signal, request, execute, onEvent } = options;
  // 不设轮数或单次操作数上限：持续执行，直到模型给出最终回复、用户停止或出错。
  while (true) {
    signal.throwIfAborted();
    onEvent({ kind: 'thinking', text: '正在思考…' });
    const message = await request(history);
    signal.throwIfAborted();
    if (message.usage) onEvent({ kind: 'usage', text: '', usage: message.usage });
    const calls = message.tool_calls ?? [];
    // Do not retain the assistant's unpaired calls on interruption. Rebuild a
    // complete protocol turn before committing it to conversational history.
    const turn: Message[] = [message];
    try {
      if (message.content) onEvent({ kind: 'text', text: message.content });
      for (const call of calls) {
        signal.throwIfAborted();
        onEvent({ kind: 'thinking', text: `正在执行 ${call.function.name}…` });
        let result: unknown; let ok = true; let localError: string | undefined;
        try { result = await execute(call); }
        catch (error) {
          signal.throwIfAborted(); ok = false;
          localError = error instanceof Error ? error.message : String(error);
          // IPC errors can contain executable/database paths. Keep diagnostics
          // in the local trace; send only a stable failure description upstream.
          result = { error: error instanceof ToolInputError ? error.message : '操作失败，请告知用户查看本地操作记录，检查参数或游戏配置；不要自动重试。' };
        }
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.function.arguments || '{}');
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch { /* 参数格式错误已由执行器处理 */ }
        // Report completed effects even if Stop arrived while an existing IPC
        // was finishing; stop only prevents subsequent operations.
        onEvent({ kind: 'tool', name: call.function.name, detail: toolDetail(call.function.name, args, result), text: `${call.function.name}：${localError ?? JSON.stringify(result)}`, ok });
        turn.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      signal.throwIfAborted();
    } catch (error) {
      // Retain completed results with explicit cancelled placeholders for the
      // rest so a later user message never silently replays previous writes.
      for (const call of calls.slice(turn.length - 1)) turn.push({ role: 'tool', tool_call_id: call.id, content: '{"cancelled":true,"message":"用户已停止后续操作"}' });
      history.push(...turn);
      throw error;
    }
    history.push(...turn);
    if (!calls.length) {
      if (!message.content?.trim()) throw new Error('模型没有返回有效内容，请检查模型和接口兼容性');
      return;
    }
  }
}
