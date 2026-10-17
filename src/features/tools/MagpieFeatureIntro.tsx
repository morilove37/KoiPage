/**
 * 「功能介绍」卡片内容 — Magpie 能做什么、怎么用，以及随包算法与注意事项。
 *
 * 纯展示组件：不读设置、不发 IPC，避免把说明文案和真实配置耦合。算法名称与
 * 内置 Magpie 0.12.1 的 `effects` 目录保持一致（见 `src-tauri/resources/magpie`）。
 */

const FEATURES = [
  {
    title: "实时高清放大",
    description: "用 GPU 缩放和后处理滤镜，把 720p / 1080p 的游戏窗口放大到屏幕分辨率，立绘和文字更清晰。",
  },
  {
    title: "多种缩放算法",
    description: "Anime4K、FSR、xBRZ、RAVU、NNEDI3、NIS 等缩放模式，配合锐化与抗锯齿滤镜，可按作品切换。",
  },
  {
    title: "一键全屏",
    description: "让游戏以窗口模式运行，聚焦窗口后按缩放快捷键（默认 Win + Shift + A）进入全屏缩放，再按一次退出。",
  },
  {
    title: "灵活的画面控制",
    description: "支持窗口化缩放、多显示器、光标缩放与自动隐藏、裁剪黑边；缩放窗口始终置顶，工具栏可随时调整参数。",
  },
  {
    title: "配置与预设",
    description: "Magpie 内可保存多套配置和缩放模式，按不同作品切换；配置由 Magpie 自己管理，恋页不会修改。",
  },
  {
    title: "低负担",
    description: "画面处理全部在 GPU 上完成，可限制帧率、查看性能统计；关闭缩放后游戏进程不受影响。",
  },
] as const;

const STEPS = [
  "在恋页启动游戏；想省一步可以开启上方「随游戏启动」，启动游戏前会先把 Magpie 准备好。",
  "切回游戏窗口，按缩放快捷键（默认 Win + Shift + A，实际以 Magpie 配置为准）开始放大。",
  "需要调整画面或算法时打开 Magpie 工具栏；结束游戏后按一次快捷键即可恢复原窗口。",
] as const;

const ALGORITHMS = [
  "Anime4K",
  "FSR",
  "FSRCNNX",
  "RAVU",
  "xBRZ",
  "NNEDI3",
  "NIS",
  "SMAA",
  "FXAA",
  "CAS",
  "Lanczos",
  "Bicubic",
  "Jinc",
  "Nearest",
  "CRT",
  "Sharpen",
  "Deband",
  "SSimDownscaler",
  "CuNNy",
] as const;

const TIPS = [
  "Magpie 默认以管理员权限运行，首次启动可能弹出 UAC 确认；内置版本与外部 Magpie 共用 %LOCALAPPDATA%\\Magpie 配置，快捷键等设置保持一致。",
  "少数独占全屏游戏需要先改成窗口或无边框窗口模式，缩放才能生效。",
  "缩放快捷键和各算法参数都在 Magpie 内修改；恋页只读取并显示当前缩放快捷键，不会改动 Magpie 配置。",
] as const;

export function MagpieFeatureIntro() {
  return <div className="space-y-5">
    <p className="text-sm leading-relaxed text-muted-foreground">
      Magpie 把游戏窗口实时放大到全屏或更大尺寸；以下能力随内置版本开箱可用，无需额外配置。
    </p>

    <section>
      <h3 className="text-sm font-medium">可以做什么</h3>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {FEATURES.map(feature => (
          <div key={feature.title} className="rounded-md border border-border bg-background/60 p-3">
            <p className="text-sm font-medium">{feature.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>

    <section>
      <h3 className="text-sm font-medium">怎么用</h3>
      <ol className="mt-2 space-y-2">
        {STEPS.map((step, index) => (
          <li key={step} className="flex gap-2.5">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
            >
              {index + 1}
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">{step}</p>
          </li>
        ))}
      </ol>
    </section>

    <section>
      <h3 className="text-sm font-medium">内置缩放算法与滤镜</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        内置 Magpie 0.12.1 随包附带以下 effects，可在 Magpie 工具栏中选择或组合。
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ALGORITHMS.map(name => (
          <span key={name} className="rounded-full border border-border bg-background/60 px-2.5 py-0.5 text-xs text-muted-foreground">
            {name}
          </span>
        ))}
      </div>
    </section>

    <section>
      <h3 className="text-sm font-medium">小提示</h3>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
        {TIPS.map(tip => <li key={tip}>{tip}</li>)}
      </ul>
    </section>
  </div>;
}
