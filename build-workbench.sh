#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
SPH_GO_BIN="${SPH_GO_BIN:-$(command -v go || true)}"
if [[ -z "$SPH_GO_BIN" || ! -x "$SPH_GO_BIN" ]]; then
  echo '未找到 Go 编译器。安装 Go 后重试，或用 SPH_GO_BIN 指定 go 可执行文件。' >&2
  exit 1
fi
export PATH="$(dirname "$SPH_GO_BIN"):$PATH"
mkdir -p dist
# Build in the upstream staging directory; source files are not minified in place.
bash build/build-go.sh -trimpath -tags 'embed_inject,sqlite_only,embed_frontend_inject' \
  -ldflags='-s -w -X main.Mode=release -X main.AppVer=261009-workbench.44' -o "$PWD/dist/wx_video_download.pending"
mv dist/wx_video_download.pending dist/wx_video_download
echo '已生成 dist/wx_video_download。请手动双击 media_workbench 根目录的 启动新视频号工作台.command。'
