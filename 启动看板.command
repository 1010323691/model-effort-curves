#!/bin/bash
# 在访达里双击：启动本机服务并打开看板。
cd "$(dirname "$0")" || exit 1

# 访达启动时 PATH 可能很短，所以同时检查常见安装位置
for py in "$(command -v python3)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -n "$py" ] && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    exec "$py" -I scripts/serve.py "$@"
  fi
done

echo "没有找到 Python 3.9 或更新版本。可以运行 xcode-select --install 安装后再试。"
[ -t 0 ] && read -r -p "按回车键关闭"
exit 1
