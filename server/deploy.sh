#!/bin/sh
# shs999 게임 서버를 오라클 161 서버에 올린다 (PC의 Git Bash에서: sh server/deploy.sh)
# 처음 한 번은 Node·Caddy 설치, 방화벽 80/443 열기, 서비스 등록까지 한다. 다음부터는 코드만 바꾸고 재시작.
set -e
KEY="/c/Users/jien0/OneDrive/바탕 화면/Claude/오라클 key/ssh-key-2026-09-09.key"
SRV=opc@161.33.208.220
cd "$(dirname "$0")"

echo "== 1. 코드 올리기 (data/ 는 그대로)"
tar -cz engine.js server.js package.json Caddyfile shs999.service caddy-shs.service \
  | ssh -i "$KEY" -o ConnectTimeout=15 $SRV 'mkdir -p ~/shs999 && tar xz -C ~/shs999'

echo "== 2. 서버 설정"
ssh -i "$KEY" -o ConnectTimeout=15 $SRV 'sh -s' <<'EOF'
set -e
T=$(mktemp -d); cd "$T"
if [ ! -x /usr/local/lib/nodejs/bin/node ]; then
  echo "-- Node 22 설치"
  V=$(curl -fsS https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep "linux-x64.tar.xz" | awk '{print $2}')
  curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$V"
  curl -fsS https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep " $V\$" | sha256sum -c -
  sudo mkdir -p /usr/local/lib/nodejs && sudo tar xJf "$V" -C /usr/local/lib/nodejs --strip-components=1
fi
# SELinux: 서비스가 실행할 파일은 bin_t 위치(/usr/local/bin)에 있어야 함 (lib_t면 V8이 메모리 실행 권한을 못 받아 죽음)
[ -x /usr/local/bin/node ] || { sudo install -m 755 /usr/local/lib/nodejs/bin/node /usr/local/bin/node; sudo restorecon /usr/local/bin/node 2>/dev/null || true; }
if [ ! -x /usr/local/bin/caddy ]; then
  echo "-- Caddy 설치"
  U=$(curl -fsS https://api.github.com/repos/caddyserver/caddy/releases/latest | grep -o 'https://[^"]*caddy_[0-9.]*_linux_amd64.tar.gz' | head -1)
  S=$(echo "$U" | sed 's/_linux_amd64.tar.gz/_checksums.txt/')
  curl -fsSL "$U" -o caddy.tgz; curl -fsSL "$S" -o sums.txt
  [ "$(sha512sum caddy.tgz | cut -d' ' -f1)" = "$(grep "$(basename "$U")" sums.txt | cut -d' ' -f1)" ] || { echo "caddy 체크섬 불일치"; exit 1; }
  tar xzf caddy.tgz caddy && sudo install -m 755 caddy /usr/local/bin/caddy
  sudo restorecon /usr/local/bin/caddy 2>/dev/null || true
fi
cd ~ && rm -rf "$T"
/usr/local/lib/nodejs/bin/node -v; /usr/local/bin/caddy version | cut -d' ' -f1

cd ~/shs999 && PATH=/usr/local/lib/nodejs/bin:$PATH npm install --omit=dev --no-audit --no-fund --loglevel=error

sudo firewall-cmd --quiet --permanent --add-service=http --add-service=https && sudo firewall-cmd --quiet --reload
sudo cp shs999.service caddy-shs.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --quiet shs999 caddy-shs
sudo systemctl restart shs999 caddy-shs
sleep 3
echo "-- 상태"
systemctl is-active shs999 caddy-shs
curl -s http://127.0.0.1:8099/status || echo "게임 서버 응답 없음: sudo journalctl -u shs999 -n 30"; echo
free -m | sed -n 2p
EOF

echo "== 3. 밖에서 https 확인 (인증서 받는 데 10~30초 걸릴 수 있음)"
for i in 1 2 3 4 5 6; do
  if curl -fsS --max-time 10 https://161-33-208-220.sslip.io/status; then echo; echo "완료"; exit 0; fi
  sleep 10
done
echo "https 응답 없음 → 오라클 콘솔에서 보안 목록(Security List)에 TCP 80, 443 수신 규칙이 있는지 확인"
exit 1
