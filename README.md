# Video Channel Workbench

一个面向本地使用的微信平台内容工作台。项目在
[`ltaoo/wx_channels_download`](https://github.com/ltaoo/wx_channels_download)
基础上开发，保留原项目许可证与署名，并扩展了本地工作台、内容归档、搜索桥接、
下载任务和指标维护等能力。

> 本项目仅用于合法的技术研究与个人内容管理。使用者应遵守平台规则、著作权、
> 隐私及所在地法律法规，不得绕过访问控制或处理无权保存的内容。

## 仓库边界

Git 仓库只保存可复用源码、测试、文档和构建定义。以下内容必须留在仓库外：

- `config.yaml`、`.env*` 及其他本机配置；
- Cookie、Token、账号会话、证书私钥和签名材料；
- SQLite 数据库、日志、缓存、PID、下载媒体及内容归档；
- `dist/`、`node_modules/`、VitePress 构建结果等生成物；
- 本机启动器、交班文件及包含绝对路径的运维记录。

仓库不包含任何私钥。`go generate ./pkg/certificate` 会在每个 clone 中生成一套已忽略的
本地开发证书对；生产运行时仍应另外生成并配置每台机器独有的证书。

## 目录结构

```text
.
├── cmd/                 # CLI 命令
├── internal/            # 应用、API、数据库、服务和平台适配器
├── pkg/                 # 可复用 Go 包
├── frontend/            # 本地工作台前端与前端测试
├── docs/                # VitePress 文档源码
├── scripts/             # 维护、桥接和仓库审计脚本
├── tests/               # Python 启动器/存储辅助逻辑测试
├── build/               # 跨平台构建脚本
├── docker/              # 可选容器定义
├── main.go              # Go 程序入口
└── build-workbench.sh   # 本地生产标签构建入口
```

更详细的文件归属规则见 [docs/project-structure.md](docs/project-structure.md)。

## 开发检查

要求 Go 1.24+、Node.js 20+ 和 Python 3.12+。本工作区内的 Python 命令必须使用
已有 Conda 环境 `conda_video`。

```sh
# 公开仓库边界与敏感文件检查
conda run --no-capture-output -n conda_video \
  python scripts/check_public_tree.py

# 前端测试
node --test frontend/tests/*.test.cjs

# Python 测试
conda run --no-capture-output -n conda_video \
  python -m unittest discover -s tests -p 'test_*.py'

# Go 测试（需要本机已安装 Go 1.24+）
go generate ./pkg/certificate
go test ./...
```

`build-workbench.sh` 会将本地二进制写入已忽略的 `dist/`。构建不会把生产资料库、
配置或凭据打包进仓库。

## 安全说明

不要在 Issue 中上传未经检查的日志、配置、数据库或截图。提交前请删除 Cookie、
Authorization Header、Token、账号标识、本机路径和个人内容。发现安全问题请按
[SECURITY.md](SECURITY.md) 处理。

## 来源与许可证

导入基线及本地改动边界见 [UPSTREAM.md](UPSTREAM.md)。许可证见 [LICENSE](LICENSE)。
原许可证包含 Commons Clause 条款，因此不要将本项目描述为“纯 MIT”。
