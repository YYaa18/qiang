# 部署

两种方式，数据格式完全一样，随时可以互相搬家。

| | 本机 + 内网穿透 | VPS |
|---|---|---|
| 适合 | 今晚就想和朋友玩 | 想让墙一直在线 |
| 要准备 | 一台 Mac、`cloudflared` | 一台 Linux VPS（1 核 1G 足够）、一个域名 |
| 地址 | 每次启动会变（`https://xxx.trycloudflare.com`） | 固定（`https://你的域名`） |
| 电脑关了 | 墙就下线 | 不受影响 |

---

## 一、本机 + 内网穿透

```bash
brew install cloudflared      # 只需一次
cd ~/Desktop/qiang
./deploy/local-tunnel.sh
```

终端里会打印一个 `https://….trycloudflare.com` 的地址，把它发给朋友就行。
脚本运行期间会阻止电脑睡眠；按 `Ctrl+C` 结束，墙随之下线，画的东西都留在 `data/` 里，下次启动还在。

注意：

- **每次启动地址都会变。** 想要固定地址，需要一个 Cloudflare 账号和托管在 Cloudflare 的域名，改用「命名隧道」（`cloudflared tunnel create qiang`），或者直接上 VPS。
- 备份：`./deploy/backup.sh ./data ~/qiang-backups`

---

## 二、VPS（Ubuntu / Debian）

以下命令以 root 执行。把 `wall.example.com` 换成你的域名，并先把域名的 A 记录指向 VPS 的 IP。

### 1. 装 Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

### 2. 放代码、建用户和数据目录

```bash
useradd --system --home /opt/qiang --shell /usr/sbin/nologin qiang
git clone https://github.com/YYaa18/qiang.git /opt/qiang   # 私有仓库需要先配好 GitHub 登录或部署密钥
cd /opt/qiang && npm ci --omit=dev
mkdir -p /var/lib/qiang/rooms /var/backups/qiang
chown -R qiang:qiang /var/lib/qiang
```

没有配 GitHub 登录的话，也可以在本机用 rsync 推上去：

```bash
rsync -av --exclude node_modules --exclude data ~/Desktop/qiang/ root@VPS:/opt/qiang/
```

### 3. 用 systemd 守护

```bash
cp /opt/qiang/deploy/qiang.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qiang
systemctl status qiang          # 看到 active (running) 即可
journalctl -u qiang -f          # 看日志
```

服务只监听 `127.0.0.1:3000`，不直接暴露到公网。

### 4. 用 Caddy 配 HTTPS

```bash
apt-get install -y caddy
cp /opt/qiang/deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile       # 把 wall.example.com 改成你的域名
systemctl reload caddy
```

Caddy 会自动申请和续期证书，WebSocket 也会自动转发。防火墙只需要放行 80 和 443：

```bash
ufw allow 80,443/tcp
```

### 5. 每天自动备份

```bash
chmod +x /opt/qiang/deploy/backup.sh
( crontab -l 2>/dev/null; echo "15 4 * * * /opt/qiang/deploy/backup.sh /var/lib/qiang /var/backups/qiang" ) | crontab -
```

每天 4:15 打一个包，保留最近 14 份。最好定期把 `/var/backups/qiang` 拷到别处一份（比如本机）：

```bash
rsync -av root@VPS:/var/backups/qiang/ ~/qiang-backups/
```

### 6. 更新

```bash
cd /opt/qiang && git pull && npm ci --omit=dev && systemctl restart qiang
```

重启时服务会先把没写完的数据存盘；在墙上的人会看到「重连中」，一两秒后自动连回。

---

## 搬家：本机 ⇄ VPS

数据就是一个目录，停掉服务后整个拷过去即可：

```bash
# 本机 → VPS
ssh root@VPS systemctl stop qiang
rsync -av ~/Desktop/qiang/data/rooms/ root@VPS:/var/lib/qiang/rooms/
ssh root@VPS "chown -R qiang:qiang /var/lib/qiang && systemctl start qiang"
```

## 数据目录里有什么

```
rooms/
  ABCD.json            这面墙的元数据：最近的矢量笔画、聊天、撤销栈、段数、冻结进度
  ABCD/
    seg-0-3.png        第 0 段的墨迹图（第 3 版）；旧笔画冻结在这里
    archive-0.jsonl    第 0 段冻结笔画的矢量存档，一行一笔；撤销旧笔时用它重画
    archive.jsonl      老版本留下的整包存档，只读不写；没有就是没有
```

`ABCD.json` 始终很小（只含最近约 150～350 笔），存盘不会随着墙变大而变慢。
存档按段分文件，所以重画某一段只读那一段——一面画了一年的墙，撤销一笔旧笔也不会卡。
从旧版本升上来的房间里会有一个 `archive.jsonl`，它不再增长，但仍然会被读取，不要删。

房间不常驻内存：有人推门才从盘上读起来，空置十分钟后存盘并请出内存。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 端口 |
| `HOST` | `0.0.0.0` | 监听地址；VPS 上设为 `127.0.0.1` |
| `DATA_DIR` | `./data/rooms` | 数据目录 |
| `QIANG_LIVE_KEEP` | `150` | 保留为矢量的最新笔画数 |
| `QIANG_BAKE_BATCH` | `200` | 多出这么多笔时冻结一批 |
| `QIANG_IDLE_EVICT_MS` | `600000` | 房间空置多久后从内存请出去 |
| `QIANG_SWEEP_MS` | `60000` | 多久检查一次空房间 |
