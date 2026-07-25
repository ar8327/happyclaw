# AgentDock macOS Desktop App

Electron 封装的 AgentDock 桌面应用，提供类 Codex 的体验：菜单栏常驻、全局热键唤起浮窗、原生窗口。

## 技术栈

- **Electron 33** — 主进程 / 渲染进程隔离
- **TypeScript 5.7** — 所有主进程 & preload 源码
- **electron-builder** — 打包签名、DMG/zip 分发、自动更新
- **WKWebView 等价层** — Chromium 渲染进程

## 目录结构

```
desktop/
├── main/              # Electron 主进程 TypeScript 源码
│   ├── app.ts              # 入口：启动顺序、生命周期、关闭逻辑
│   ├── paths.ts            # Dev vs Packaged 路径解析 + 端口探测
│   ├── backend.ts          # AgentDock Node 后端子进程启动管理
│   ├── window-manager.ts   # 主窗口 + 浮动窗口 + IPC handler
│   ├── tray.ts             # 菜单栏托盘 + 状态更新
│   ├── shortcuts.ts        # 全局快捷键 (Cmd+Shift+Space 等)
│   └── auto-launch.ts      # 开机自启（Login Item）
├── preload/
│   └── index.ts            # contextBridge 暴露 `window.agentdockNative`
├── build/                  # 图标、entitlements、DMG 背景
│   └── entitlements.mac.plist
├── tsconfig.json
├── electron-builder.yml
└── package.json
```

## 快速开始（开发模式）

```bash
# 1. 回到仓库根目录，首次启动自动安装所有依赖 + 编译
cd ..
make install-desktop   # 只装桌面端依赖
make dev-desktop       # 编译后端+前端+桌面端，启动 Electron
```

或直接用 npm 脚本：

```bash
npm run install:desktop
npm run dev:desktop
```

## 关键交互

| 能力                | 说明                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| **菜单栏图标**      | 常驻状态栏；左键切换浮动对话窗；右键打开完整菜单                                          |
| **Cmd+Shift+Space** | 全局热键：显示 / 隐藏 Codex 式浮动对话窗                                                  |
| **Cmd+Shift+O**     | 打开主窗口（完整 AgentDock 管理界面）                                                     |
| **Cmd+,**           | 偏好设置                                                                                  |
| **关闭全部窗口**    | macOS 下应用保留在菜单栏（dock 隐藏），不退出                                             |
| **agentdock://**    | Deep Link：`agentdock://open/sessions/xxx` 打开指定 Session；`agentdock://float` 唤起浮窗 |

## 数据目录

打包后数据写入 macOS 标准目录，**不会污染安装目录**：

| 用途                   | 路径                                              |
| ---------------------- | ------------------------------------------------- |
| 数据库 / 会话 / 工作区 | `~/Library/Application Support/AgentDock/data/`   |
| 后端运行日志           | `~/Library/Logs/AgentDock/backend-YYYY-MM-DD.log` |
| Electron 崩溃日志      | `~/Library/Logs/DiagnosticReports/`               |
| 端口占位文件           | `~/Library/Application Support/AgentDock/port`    |

开发模式固定使用仓库根 `data/`；打包应用固定使用 macOS 标准目录。需要临时覆盖时可设置 `AGENTDOCK_DATA_DIR`。

## 打包发布

```bash
# 仅编译 TS（验证无类型错误）
make build-desktop

# 生成 .app 目录到 desktop/release/mac-arm64/AgentDock.app
make pack-desktop

# 生成 DMG + zip（发布用）
make dist-desktop
```

产物位置：`desktop/release/`

### 自定义图标

把 PNG 原图放到 `desktop/build/icon.png`（≥ 1024×1024），然后用 `iconutil` 生成 `.icns`：

```bash
cd desktop/build
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset
```

同时把 PNG 重命名为 `icon-Template.png`（黑白单色 18×18）作为菜单栏模板图标。

## 架构说明（简）

```
Electron 主进程
   ├─ 启动 AgentDock 后端（Node 子进程，动态端口）
   ├─ 监听 stdout marker → 获取端口
   ├─ 创建主窗口 + 浮动窗口（BrowserWindow → http://127.0.0.1:<port>）
   ├─ 注册托盘 + 全局快捷键
   └─ 通过 preload contextBridge 暴露原生 API
         ↓ contextBridge
Web SPA（原 AgentDock 前端，零改动）
   ├─ `window.__AGENTDOCK_DESKTOP__` 为 true 时启用桌面端适配
   └─ `window.agentdockNative.*` 调用原生能力
```

后端通过环境变量 `AGENTDOCK_DESKTOP_MODE=1`、`DATA_DIR`、`WEB_PORT` 与桌面壳通信，避免直接代码耦合。

## 常见问题

**Q: 启动后端报错端口被占用？**
A: 壳会从 3000 开始向上探测 20 个端口，实在没空闲就交给 OS 分配。手动设置也可以：`WEB_PORT=9000 npm run dev:desktop`。

**Q: Claude / Codex CLI 找不到？**
A: 后端 runner 子进程继承 Electron 的 PATH。如果 CLI 装在非标准路径（如 nvm / homebrew 自定义 prefix），在 shell 配置里把它们加到 launchd 可见的 PATH，或在设置里单独指定。

**Q: 退出后再次打开数据库被锁？**
A: `before-quit` 会先 SIGINT 停后端再 SIGTERM 兜底；如果强制杀进程导致 `.db-wal` 残留，删除 `~/Library/Application Support/AgentDock/data/db/*.db-wal` 即可（SQLite 下次启动会自动 replay）。
