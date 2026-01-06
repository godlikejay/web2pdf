#!/bin/bash
set -e

# 如果挂载了 /app/fonts 目录，则安装字体
if [ -d "/app/fonts" ] && [ "$(ls -A /app/fonts)" ]; then
    echo "Found fonts directory, installing custom fonts..."
    
    # 因为容器运行时通常不是 root，需要确保有权限或者目标目录可写
    # 在 Dockerfile 中我们需要预先创建好目录并给予权限
    
    # 假设 Dockerfile 已经确保了 /usr/share/fonts/truetype/custom 是可写的，或者我们复制到用户目录下的 .fonts
    # 但 fc-cache 系统级更新通常需要 root。
    # 如果作为非 root 运行，我们可以尝试使用用户级字体配置。
    
    mkdir -p /home/pptruser/.fonts
    cp /app/fonts/* /home/pptruser/.fonts/
    fc-cache -f -v
    echo "Custom fonts installed to ~/.fonts"
else
    echo "No custom fonts found in /app/fonts"
fi

# 启动应用
exec node server.js
