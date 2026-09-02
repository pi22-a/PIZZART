#!/usr/bin/env bash
#
# Lightsail(Ubuntu) 첫 세팅. 서버에 접속해서 한 번만 돌린다.
#
#   bash setup-server.sh
#
# 하는 일: 스왑 만들기 → Node 설치 → 저장소 받기 → 빌드 → 서비스 등록.
# 터널은 따로 붙인다(아래 안내 참조). 이 스크립트는 아무 포트도 열지 않는다.
set -euo pipefail

echo "== 1/5 스왑 =="
# 512MB짜리에서 vite 빌드가 메모리를 넘길 수 있다. 스왑이 있으면 느려질 뿐 안 죽는다.
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  echo "  스왑 2G 만듦"
else
  echo "  이미 있음"
fi

echo "== 2/5 Node =="
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

echo "== 3/5 저장소 =="
# 비공개 저장소다. 배포 키(읽기 전용)를 먼저 GitHub에 등록해 두어야 한다.
if [ ! -d "$HOME/PIZZART" ]; then
  git clone git@github.com:pi22-a/PIZZART.git "$HOME/PIZZART"
fi
cd "$HOME/PIZZART"
git fetch --tags
# 공개에는 언제나 태그를 쓴다. 브랜치를 쓰면 개발 중인 것이 사용자에게 나간다.
LATEST=$(git tag --sort=-v:refname | head -1)
git checkout "$LATEST"
echo "  버전: $LATEST"

echo "== 4/5 빌드 =="
npm ci
npm run build

echo "== 5/5 서비스 =="
sudo cp deploy/pizzart.service /etc/systemd/system/pizzart.service
sudo systemctl daemon-reload
sudo systemctl enable --now pizzart
sleep 2
sudo systemctl --no-pager status pizzart | head -5

echo
echo "완료. 확인: curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8090/"
echo "다음은 터널을 붙인다 — docs/RELEASE.md 의 '서버로 옮기기' 참조."
