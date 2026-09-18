#!/usr/bin/env bash
# 备份所有墙的数据：打一个带日期的包，保留最近 14 份。
# 用法：backup.sh [数据目录] [备份目录]
# VPS 上用 cron 每天跑一次：
#   15 4 * * * /opt/qiang/deploy/backup.sh /var/lib/qiang /var/backups/qiang
set -euo pipefail

DATA="${1:-/var/lib/qiang}"
DEST="${2:-/var/backups/qiang}"
KEEP="${KEEP:-14}"

mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/qiang-$STAMP.tar.gz"

# 房间 JSON 是先写临时文件再改名的，墨迹图也是；直接打包即可，不用停服务
tar -czf "$OUT.part" -C "$(dirname "$DATA")" "$(basename "$DATA")"
mv "$OUT.part" "$OUT"
echo "备份完成：$OUT（$(du -h "$OUT" | cut -f1)）"

# 只保留最近 KEEP 份
ls -1t "$DEST"/qiang-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
